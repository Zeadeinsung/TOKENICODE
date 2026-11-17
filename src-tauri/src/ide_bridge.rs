//! IDE integration bridge for Claude Code CLI.
//!
//! The CLI discovers a running IDE by reading `<home>/.claude/ide/<port>.lock`.
//! A lock with `"transport": "ws"` makes the CLI dial `ws://127.0.0.1:<port>`
//! and speak MCP JSON-RPC over that socket. The handshake carries the lock's
//! `authToken` in the `x-claude-code-ide-authorization` header.
//!
//! Once connected the CLI treats this server as the `ide` MCP server and
//! exposes its tools as `mcp__ide__*`. The editor pushes state here through
//! Tauri commands; requests that need UI action are forwarded to the frontend
//! as events.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State as AxumState,
    },
    http::HeaderMap,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, RwLock};

const IDE_AUTH_HEADER: &str = "x-claude-code-ide-authorization";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OpenEditor {
    pub file_path: String,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub is_dirty: bool,
    #[serde(default)]
    pub language_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelectionInfo {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub selection: Option<Value>,
    #[serde(default)]
    pub line_start: Option<u64>,
    #[serde(default)]
    pub line_count: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditorStatePayload {
    #[serde(default)]
    pub workspace_folders: Vec<String>,
    #[serde(default)]
    pub open_editors: Vec<OpenEditor>,
    #[serde(default)]
    pub current_selection: Option<SelectionInfo>,
    #[serde(default)]
    pub latest_selection: Option<SelectionInfo>,
    #[serde(default)]
    pub active_file: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DiagnosticEntry {
    pub message: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub range: Value,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub code: Option<Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DiagnosticsPayload {
    pub uri: String,
    pub diagnostics: Vec<DiagnosticEntry>,
    #[serde(default)]
    pub lines_in_file: Option<u64>,
}

#[derive(Default)]
pub struct BridgeInner {
    pub state: EditorStatePayload,
    pub diagnostics: HashMap<String, DiagnosticsPayload>,
}

pub struct IdeBridgeState {
    pub port: u16,
    pub auth_token: String,
    pub inner: RwLock<BridgeInner>,
    /// Full JSON-RPC notifications (diagnostics_changed, selection_changed).
    pub notify_tx: broadcast::Sender<Value>,
}

pub type SharedBridge = Arc<IdeBridgeState>;

/// Start the WebSocket server, write the lock file, and keep it alive for the
/// lifetime of the app. Called once from `run()`'s setup hook.
pub fn start(app: AppHandle) {
    // Bind synchronously so `ide_bridge_port` is usable before the first
    // session starts. Binding 127.0.0.1:0 asks the OS for a free port.
    let std_listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[ide_bridge] bind failed: {e}");
            return;
        }
    };
    if let Err(e) = std_listener.set_nonblocking(true) {
        eprintln!("[ide_bridge] set_nonblocking failed: {e}");
        return;
    }
    let port = match std_listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("[ide_bridge] local_addr failed: {e}");
            return;
        }
    };

    let auth_token = uuid::Uuid::new_v4().to_string();
    let (notify_tx, _) = broadcast::channel::<Value>(64);
    let bridge: SharedBridge = Arc::new(IdeBridgeState {
        port,
        auth_token: auth_token.clone(),
        inner: RwLock::new(BridgeInner::default()),
        notify_tx,
    });

    if let Err(e) = write_lock_file(port, &auth_token) {
        eprintln!("[ide_bridge] failed to write lock file: {e}");
    }
    eprintln!("[ide_bridge] listening on ws://127.0.0.1:{port}");

    app.manage(BridgeHandle(bridge.clone()));

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[ide_bridge] from_std failed: {e}");
                return;
            }
        };
        let router = Router::new()
            .route("/", get(ws_handler))
            .with_state((bridge, app));

        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[ide_bridge] server stopped: {e}");
        }
    });
}

/// Tauri-managed wrapper so commands can reach the bridge.
pub struct BridgeHandle(pub SharedBridge);

fn lock_path(port: u16) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".claude")
            .join("ide")
            .join(format!("{port}.lock")),
    )
}

fn write_lock_file(port: u16, auth_token: &str) -> std::io::Result<()> {
    let Some(path) = lock_path(port) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no home directory",
        ));
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let payload = json!({
        "pid": std::process::id(),
        "workspaceFolders": [],
        "ideName": "TOKENICODE",
        "transport": "ws",
        "runningInWindows": cfg!(target_os = "windows"),
        "authToken": auth_token,
    });
    std::fs::write(&path, serde_json::to_string(&payload)?)
}

async fn ws_handler(
    AxumState((bridge, app)): AxumState<(SharedBridge, AppHandle)>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let authorized = headers
        .get(IDE_AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == bridge.auth_token)
        .unwrap_or(false)
        || query
            .get("token")
            .map(|v| v == &bridge.auth_token)
            .unwrap_or(false);
    if !authorized {
        eprintln!("[ide_bridge] rejected unauthorized websocket connection");
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, bridge, app))
        .into_response()
}

async fn send_json(socket: &mut WebSocket, value: Value) {
    let text = value.to_string();
    if let Err(e) = socket.send(Message::Text(text.into())).await {
        eprintln!("[ide_bridge] send failed: {e}");
    }
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

async fn handle_socket(mut socket: WebSocket, bridge: SharedBridge, app: AppHandle) {
    let mut notify_rx = bridge.notify_tx.subscribe();
    loop {
        tokio::select! {
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let parsed: Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                eprintln!("[ide_bridge] bad json: {e}");
                                continue;
                            }
                        };
                        let method = parsed.get("method").and_then(|m| m.as_str()).unwrap_or("");
                        let id = parsed.get("id").cloned();
                        let params = parsed.get("params").cloned().unwrap_or(Value::Null);

                        if method == "notifications/initialized" {
                            continue;
                        }
                        if method == "ide_connected" {
                            eprintln!("[ide_bridge] CLI connected");
                            continue;
                        }
                        if id.is_none() {
                            // Notification: nothing to answer.
                            continue;
                        }

                        let result = dispatch_rpc(method, &params, &bridge, &app).await;
                        let response = match result {
                            Ok(value) => ok_response(id.unwrap(), value),
                            Err((code, message)) => {
                                error_response(id.unwrap(), code, &message)
                            }
                        };
                        send_json(&mut socket, response).await;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        eprintln!("[ide_bridge] socket error: {e}");
                        break;
                    }
                }
            }
            notification = notify_rx.recv() => {
                if let Ok(value) = notification {
                    send_json(&mut socket, value).await;
                }
            }
        }
    }
    eprintln!("[ide_bridge] CLI disconnected");
}

async fn dispatch_rpc(
    method: &str,
    params: &Value,
    bridge: &SharedBridge,
    app: &AppHandle,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "tokenicode-ide", "version": env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Ok(json!({"tools": tool_definitions()})),
        "tools/call" => call_tool(params, bridge, app).await,
        "ping" => Ok(json!({})),
        other => Err((-32601, format!("method not found: {other}"))),
    }
}

fn text_result(value: Value) -> Value {
    let text = match value {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    json!({"content": [{"type": "text", "text": text}]})
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "getOpenEditors",
            "description": "Get information about currently open editors",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "getWorkspaceFolders",
            "description": "Get all workspace folders currently open in the IDE",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "getCurrentSelection",
            "description": "Get the current text selection in the active editor",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "getLatestSelection",
            "description": "Get the most recent text selection (even if not in the active editor)",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "getDiagnostics",
            "description": "Get language diagnostics from the editor",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "uri": {"type": "string", "description": "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files."}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "openFile",
            "description": "Open a file in the editor and optionally select a range of text",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": {"type": "string", "description": "Path to the file to open"},
                    "preview": {"type": "boolean", "description": "Whether to open the file in preview mode"},
                    "startText": {"type": "string", "description": "Text pattern to find the start of the selection range."},
                    "endText": {"type": "string", "description": "Text pattern to find the end of the selection range."},
                    "selectToEndOfLine": {"type": "boolean"},
                    "makeFrontmost": {"type": "boolean"}
                },
                "required": ["filePath"],
                "additionalProperties": false
            }
        },
        {
            "name": "openDiff",
            "description": "Open a diff view for a file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_file_path": {"type": "string"},
                    "new_file_path": {"type": "string"},
                    "new_file_contents": {"type": "string"},
                    "tab_name": {"type": "string"}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "checkDocumentDirty",
            "description": "Check if a document has unsaved changes (is dirty)",
            "inputSchema": {
                "type": "object",
                "properties": {"filePath": {"type": "string"}},
                "required": ["filePath"],
                "additionalProperties": false
            }
        },
        {
            "name": "saveDocument",
            "description": "Save a document with unsaved changes",
            "inputSchema": {
                "type": "object",
                "properties": {"filePath": {"type": "string"}},
                "required": ["filePath"],
                "additionalProperties": false
            }
        }
    ])
}

async fn call_tool(
    params: &Value,
    bridge: &SharedBridge,
    app: &AppHandle,
) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or((-32602, "tools/call missing name".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "getOpenEditors" => {
            let inner = bridge.inner.read().await;
            Ok(text_result(json!({
                "editors": inner.state.open_editors,
                "activeFile": inner.state.active_file
            })))
        }
        "getWorkspaceFolders" => {
            let inner = bridge.inner.read().await;
            Ok(text_result(json!({"folders": inner.state.workspace_folders})))
        }
        "getCurrentSelection" => {
            let inner = bridge.inner.read().await;
            match &inner.state.current_selection {
                Some(sel) => Ok(text_result(serde_json::to_value(sel).unwrap_or_default())),
                None => Ok(text_result(json!({"success": false, "message": "No selection available"}))),
            }
        }
        "getLatestSelection" => {
            let inner = bridge.inner.read().await;
            match &inner.state.latest_selection {
                Some(sel) => Ok(text_result(serde_json::to_value(sel).unwrap_or_default())),
                None => Ok(text_result(json!({"success": false, "message": "No selection available"}))),
            }
        }
        "getDiagnostics" => {
            let inner = bridge.inner.read().await;
            let uri = args.get("uri").and_then(|u| u.as_str());
            let files: Vec<Value> = match uri {
                Some(target) => inner
                    .diagnostics
                    .values()
                    .filter(|d| d.uri == target)
                    .map(|d| {
                        json!({
                            "uri": d.uri,
                            "diagnostics": d.diagnostics,
                            "linesInFile": d.lines_in_file
                        })
                    })
                    .collect(),
                None => inner
                    .diagnostics
                    .values()
                    .map(|d| {
                        json!({
                            "uri": d.uri,
                            "diagnostics": d.diagnostics,
                            "linesInFile": d.lines_in_file
                        })
                    })
                    .collect(),
            };
            Ok(text_result(Value::Array(files)))
        }
        "openFile" => {
            let path = args
                .get("filePath")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            let _ = app.emit("ide-open-file", &args);
            Ok(text_result(json!({"success": true, "filePath": path})))
        }
        "openDiff" => {
            let _ = app.emit("ide-open-diff", &args);
            Ok(text_result(json!("OPENED_DIFF")))
        }
        "checkDocumentDirty" => {
            let path = args
                .get("filePath")
                .and_then(|p| p.as_str())
                .unwrap_or_default();
            let inner = bridge.inner.read().await;
            let dirty = inner
                .state
                .open_editors
                .iter()
                .find(|e| e.file_path == path)
                .map(|e| e.is_dirty)
                .unwrap_or(false);
            Ok(text_result(json!({"isDirty": dirty})))
        }
        "saveDocument" => {
            let path = args
                .get("filePath")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            let _ = app.emit("ide-save-document", &path);
            Ok(text_result(json!({"success": true})))
        }
        other => Err((-32601, format!("unknown tool: {other}"))),
    }
}

/// Frontend pushes the full editor state (open tabs, active file, selection).
#[tauri::command]
pub async fn ide_update_editor_state(
    app: AppHandle,
    payload: EditorStatePayload,
) -> Result<(), String> {
    let Some(handle) = app.try_state::<BridgeHandle>() else {
        return Ok(());
    };

    // Mirror the VSCode extension: selection changes are pushed as a
    // notification rather than polled through a tool.
    let selection_notice = payload.current_selection.as_ref().map(|sel| {
        json!({
            "jsonrpc": "2.0",
            "method": "selection_changed",
            "params": {
                "selection": sel.selection,
                "text": sel.text,
                "filePath": sel.file_path,
            }
        })
    });

    {
        let mut inner = handle.0.inner.write().await;
        inner.state = payload;
    }

    if let Some(notice) = selection_notice {
        let _ = handle.0.notify_tx.send(notice);
    }
    Ok(())
}

/// Frontend pushes the diagnostics it knows about.
#[tauri::command]
pub async fn ide_update_diagnostics(
    app: AppHandle,
    payloads: Vec<DiagnosticsPayload>,
) -> Result<(), String> {
    let Some(handle) = app.try_state::<BridgeHandle>() else {
        return Ok(());
    };
    let mut uris = Vec::with_capacity(payloads.len());
    {
        let mut inner = handle.0.inner.write().await;
        inner.diagnostics.clear();
        for p in payloads {
            uris.push(p.uri.clone());
            inner.diagnostics.insert(p.uri.clone(), p);
        }
    }
    let _ = handle.0.notify_tx.send(json!({
        "jsonrpc": "2.0",
        "method": "diagnostics_changed",
        "params": {"uris": uris}
    }));
    Ok(())
}

/// The CLI needs the port before it starts. The session launcher reads this.
#[tauri::command]
pub fn ide_bridge_port(app: AppHandle) -> Option<u16> {
    app.try_state::<BridgeHandle>().map(|h| h.0.port)
}

/// Build the `mcpServers.ide` entry for a stream-json CLI session.
///
/// `-p` / stream-json sessions never mount the UI hook that auto-discovers
/// `~/.claude/ide/*.lock`, so the bridge has to arrive as an ordinary stdio
/// MCP server. The proxy script is embedded here and materialized under
/// `~/.tokenicode/`, which keeps release builds independent of the source tree.
pub fn mcp_server_config(port: u16, auth_token: &str) -> Option<Value> {
    const PROXY: &str = include_str!("../../scripts/ide-mcp-stdio.mjs");

    let dir = dirs::home_dir()?.join(".tokenicode");
    std::fs::create_dir_all(&dir).ok()?;
    let script = dir.join("ide-mcp-stdio.mjs");
    let current = std::fs::read_to_string(&script).unwrap_or_default();
    if current != PROXY {
        std::fs::write(&script, PROXY).ok()?;
    }

    Some(json!({
        "command": "node",
        "args": [
            script.to_string_lossy(),
            format!("ws://127.0.0.1:{port}/?token={auth_token}")
        ],
    }))
}

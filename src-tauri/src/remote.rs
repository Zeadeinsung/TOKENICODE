//! Remote mirror + control server.
//!
//! Mirrors TOKENICODE's live backend→frontend event stream (the exact same
//! payloads the desktop WebView receives) to a phone over WebSocket, and
//! accepts control ops that reuse the existing Tauri commands (send message,
//! respond to permission, interrupt, resume/start a session).
//!
//! Security model: bind to the Tailscale interface plus loopback (never
//! 0.0.0.0) and require a bearer token. TOKENICODE runs the CLI with bypass
//! permissions, so a connected client has full control of this machine — the
//! tailnet/loopback + token are the only gates.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::commands::{BypassModeMap, ProcessManager, StartSessionParams, StdinManager};
use crate::path_access::PathAccessManager;

/// Raw JSONL budget for one `loadSession` reply. A single WebSocket frame has
/// to survive the tunnel, and transcripts here run to a hundred megabytes.
const DEFAULT_HISTORY_BYTES: u64 = 2 * 1024 * 1024;

/// Broadcast hub. Set once during `start()`.
static TX: OnceLock<broadcast::Sender<RemoteEvent>> = OnceLock::new();
/// stdin_ids of sessions the phone started, awaiting their `system:init`
/// event so we can register the Claude CLI UUID as tracked (otherwise the
/// desktop session list would hide them).
static PENDING_TRACK: OnceLock<Arc<Mutex<Vec<String>>>> = OnceLock::new();
/// Live stdin_id → Claude CLI session UUID map, learned from the mirrored
/// stream. Lets the phone correlate running processes with session history.
static ACTIVE_MAP: OnceLock<Arc<Mutex<HashMap<String, String>>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
pub struct RemoteEvent {
    /// The original Tauri event name, e.g. `claude:stream:<stdin_id>`.
    pub ev: String,
    pub data: Value,
}

/// Mirror a frontend-bound event onto the broadcast hub. Non-blocking and
/// cheap when nobody is connected.
pub fn publish<S: Serialize>(ev: &str, payload: &S) {
    let Some(tx) = TX.get() else {
        return;
    };
    if tx.receiver_count() == 0 {
        return;
    }
    let Ok(data) = serde_json::to_value(payload) else {
        return;
    };
    // send() only errors when there are no receivers, which we just checked.
    let _ = tx.send(RemoteEvent {
        ev: ev.to_string(),
        data,
    });
}

#[derive(Clone, Serialize, Deserialize)]
struct RemoteConfig {
    enabled: bool,
    /// Bind address. Use the Tailscale IP; never 0.0.0.0.
    host: String,
    port: u16,
    token: String,
    /// Path to the self-contained mobile HTML served at `/`.
    mobile_html: String,
}

fn config_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".tokenicode")
        .join("remote.json")
}

/// Best-effort detection of this machine's Tailscale (100.64.0.0/10) IPv4.
fn detect_tailscale_ip() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("ipconfig").output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(pos) = line.find("IPv4") {
                if let Some(colon) = line[pos..].find(':') {
                    let ip = line[pos + colon + 1..].trim();
                    if ip.starts_with("100.") {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for bin in ["ip", "ifconfig"] {
            if let Ok(out) = std::process::Command::new(bin).arg("-4").arg("addr").output() {
                let text = String::from_utf8_lossy(&out.stdout);
                for tok in text.split_whitespace() {
                    let ip = tok.trim_end_matches('/');
                    if ip.starts_with("100.") && ip.matches('.').count() == 3 {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Default path to the built mobile page: resolved relative to the executable
/// (`<root>/src-tauri/target/release/tokenicode.exe` → `<root>/remote-mobile/dist/index.html`),
/// with a literal fallback.
fn default_mobile_html_path() -> String {
    if let Ok(exe) = std::env::current_exe() {
        let root = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent());
        if let Some(root) = root {
            return root
                .join("remote-mobile")
                .join("dist")
                .join("index.html")
                .to_string_lossy()
                .to_string();
        }
    }
    r"D:\TOKENICODE-main\TOKENICODE-main\remote-mobile\dist\index.html".to_string()
}

fn load_or_create_config() -> RemoteConfig {
    let path = config_path();
    if let Ok(txt) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<RemoteConfig>(&txt) {
            Ok(cfg) => return cfg,
            Err(e) => eprintln!("[remote] config parse error ({e}); regenerating"),
        }
    }
    let cfg = RemoteConfig {
        enabled: true,
        host: detect_tailscale_ip().unwrap_or_else(|| "127.0.0.1".to_string()),
        port: 8787,
        token: uuid::Uuid::new_v4().simple().to_string(),
        mobile_html: default_mobile_html_path(),
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&cfg) {
        let _ = std::fs::write(&path, s);
    }
    eprintln!(
        "[remote] created config {} (host={} port={} token={})",
        path.display(),
        cfg.host,
        cfg.port,
        cfg.token
    );
    cfg
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    /// Behind a lock so a token rotated in `remote.json` takes effect without a
    /// desktop restart; `watch_config` refreshes it. Live sockets are not
    /// re-authenticated, so rotating only affects the *next* connection.
    token: Arc<RwLock<String>>,
    tx: broadcast::Sender<RemoteEvent>,
    mobile_html: String,
}

impl Ctx {
    fn token(&self) -> String {
        self.token.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Re-read `remote.json` every couple of seconds and swap in a rotated token.
/// Read a tiny file on a timer instead of tracking mtime: the file is small,
/// and mtime granularity can swallow two writes inside one tick.
///
/// Bind address and `enabled` are deliberately not hot-reloaded — both need the
/// listeners torn down, which is exactly what a restart is for.
fn watch_config(ctx: Ctx) {
    let path = config_path();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let Ok(txt) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(cfg) = serde_json::from_str::<RemoteConfig>(&txt) else {
                continue;
            };
            let mut guard = ctx.token.write().unwrap_or_else(|e| e.into_inner());
            if *guard != cfg.token {
                *guard = cfg.token;
                eprintln!("[remote] token reloaded from {}", path.display());
            }
        }
    });
}

/// Constant-time string compare to avoid token timing leaks.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn token_ok(q: &HashMap<String, String>, expected: &str) -> bool {
    q.get("token").map(|t| ct_eq(t, expected)).unwrap_or(false)
}

async fn root_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if !token_ok(&q, &ctx.token()) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }
    match std::fs::read_to_string(&ctx.mobile_html) {
        Ok(html) => Html(html).into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            format!("mobile page not found at {}: {e}", ctx.mobile_html),
        )
            .into_response(),
    }
}

async fn ws_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    if !token_ok(&q, &ctx.token()) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

async fn handle_socket(socket: WebSocket, ctx: Ctx) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = ctx.tx.subscribe();
    // Replies to inbound ops funnel through here so a single writer task owns
    // the sink (broadcast events + RPC results share one connection).
    let (reply_tx, mut reply_rx) = mpsc::channel::<String>(512);

    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Ok(ev) => {
                        let Ok(txt) = serde_json::to_string(&ev) else { continue };
                        if sink.send(Message::Text(txt.into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[remote] client lagged, dropped {n} events");
                        continue;
                    }
                    Err(_) => break,
                },
                Some(line) = reply_rx.recv() => {
                    if sink.send(Message::Text(line.into())).await.is_err() { break; }
                }
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(txt) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else {
            continue;
        };
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let out = match handle_op(&ctx, &v).await {
            Ok(data) => json!({"ev": "rpc:result", "id": id, "ok": true, "data": data}),
            Err(e) => json!({"ev": "rpc:result", "id": id, "ok": false, "error": e}),
        };
        if reply_tx.send(out.to_string()).await.is_err() {
            break;
        }
    }
    writer.abort();
}

async fn handle_op(ctx: &Ctx, v: &Value) -> Result<Value, String> {
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);

    match op {
        "ping" => Ok(json!({"pong": true})),

        "listSessions" => crate::list_sessions_inner().await.map(|v| json!(v)),

        "listRecentProjects" => crate::list_recent_projects_inner().await.map(|v| json!(v)),

        "loadSession" => {
            let path = s("path").ok_or("missing path")?;
            // The transcript has to fit in one WebSocket frame on a link that
            // measures in seconds, so the phone gets the tail, not the whole file.
            let max = v
                .get("maxBytes")
                .and_then(|x| x.as_u64())
                .unwrap_or(DEFAULT_HISTORY_BYTES);
            crate::load_session_tail_inner(path, max)
                .await
                .map(|v| json!(v))
        }

        "listActive" => {
            let pm = ctx.app.state::<ProcessManager>();
            let ids = pm.active_ids().await;
            let map = ACTIVE_MAP.get().map(|m| m.clone());
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                let cli = match &map {
                    Some(m) => m.lock().await.get(&id).cloned(),
                    None => None,
                };
                out.push(json!({ "stdinId": id, "cliSessionId": cli }));
            }
            Ok(json!(out))
        }

        "listProviders" => {
            let p = crate::providers_path()?;
            let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            serde_json::from_str::<Value>(&txt).map_err(|e| e.to_string())
        }

        "listDir" => list_dir(&s("path").unwrap_or_default()),

        // The CLI applies CLAUDE_CODE_MAX_CONTEXT_TOKENS to every model it
        // spawns, so the phone needs it to turn window occupancy into a
        // percentage for proxied ids (deepseek-flash and the like). Only the
        // one number is returned: settings.json also holds API keys.
        "contextSettings" => read_context_settings(),

        "setPermissionMode" => {
            let stdin = ctx.app.state::<StdinManager>().inner().clone();
            let bm = ctx.app.state::<BypassModeMap>().inner().clone();
            let mode = s("mode").unwrap_or_else(|| "default".to_string());
            crate::send_control_request_inner(
                stdin,
                bm,
                s("sessionId").unwrap_or_default(),
                "set_permission_mode".to_string(),
                json!({ "mode": mode }),
            )
            .await?;
            Ok(json!({"ok": true}))
        }

        "setModel" => {
            let stdin = ctx.app.state::<StdinManager>().inner().clone();
            let bm = ctx.app.state::<BypassModeMap>().inner().clone();
            crate::send_control_request_inner(
                stdin,
                bm,
                s("sessionId").unwrap_or_default(),
                "set_model".to_string(),
                json!({ "model": v.get("model").cloned().unwrap_or(Value::Null) }),
            )
            .await?;
            Ok(json!({"ok": true}))
        }

        // Names, pins and archives live in small JSON ledgers next to the
        // session files. The phone reads all three in one round trip because
        // each one is a separate request on a link that measures in seconds.
        "sessionMeta" => Ok(json!({
            "customPreviews": read_json_file(&crate::session_names_path()?, json!({})),
            "pinned": read_json_file(&crate::tokenicode_data_path("pinned.json")?, json!([])),
            "archived": read_json_file(&crate::tokenicode_data_path("archived.json")?, json!([])),
        })),

        "renameSession" => {
            let id = s("sessionId").ok_or("missing sessionId")?;
            let name = s("name").unwrap_or_default();
            let path = crate::session_names_path()?;
            let mut map = read_json_file(&path, json!({}));
            if let Some(obj) = map.as_object_mut() {
                if name.trim().is_empty() {
                    obj.remove(&id);
                } else {
                    obj.insert(id, Value::String(name));
                }
            }
            write_json_file(&path, &map)?;
            Ok(json!({"ok": true}))
        }

        "pinSession" => {
            let id = s("sessionId").ok_or("missing sessionId")?;
            let pinned = v.get("pinned").and_then(|b| b.as_bool()).unwrap_or(true);
            toggle_id_list(&crate::tokenicode_data_path("pinned.json")?, &id, pinned)?;
            Ok(json!({"ok": true}))
        }

        "archiveSession" => {
            let id = s("sessionId").ok_or("missing sessionId")?;
            let archived = v.get("archived").and_then(|b| b.as_bool()).unwrap_or(true);
            toggle_id_list(&crate::tokenicode_data_path("archived.json")?, &id, archived)?;
            Ok(json!({"ok": true}))
        }

        "deleteSession" => {
            let id = s("sessionId").ok_or("missing sessionId")?;
            let path = s("path").unwrap_or_default();
            // Reuses the desktop path, which refuses anything outside
            // ~/.claude/projects/ and cleans tracked_sessions.txt.
            crate::delete_session_inner(id, path).await?;
            Ok(json!({"ok": true}))
        }

        "searchSessions" => {
            let query = s("query").unwrap_or_default();
            crate::search_sessions_inner(query).await.map(|v| json!(v))
        }

        "send" => {
            let sid = s("sessionId").ok_or("missing sessionId")?;
            let msg = s("message").ok_or("missing message")?;
            let stdin = ctx.app.state::<StdinManager>().inner().clone();
            crate::send_stdin_inner(stdin, sid, msg).await?;
            Ok(json!({"sent": true}))
        }

        "permission" => {
            let stdin = ctx.app.state::<StdinManager>().inner().clone();
            let sid = s("sessionId").unwrap_or_default();
            let rid = s("requestId").unwrap_or_default();
            let allow = v.get("allow").and_then(|b| b.as_bool()).unwrap_or(false);
            let tuid = s("toolUseId");
            crate::respond_permission_inner(
                stdin,
                sid.clone(),
                rid.clone(),
                allow,
                s("message"),
                tuid.clone(),
                v.get("updatedInput").cloned(),
            )
            .await?;
            // The answer came from the phone, so the desktop's copy of the card
            // is still sitting there interactive — the CLI just moves on and the
            // desktop never learns. Re-emit the resolution to both ends.
            let _ = crate::events::emit_to_frontend(
                &ctx.app,
                "permission:resolved",
                json!({
                    "stdinId": sid,
                    "requestId": rid,
                    "toolUseId": tuid,
                    "allow": allow,
                    "source": "remote",
                }),
            );
            Ok(json!({"ok": true}))
        }

        "interrupt" => {
            let stdin = ctx.app.state::<StdinManager>().inner().clone();
            let bm = ctx.app.state::<BypassModeMap>().inner().clone();
            crate::send_control_request_inner(
                stdin,
                bm,
                s("sessionId").unwrap_or_default(),
                "interrupt".to_string(),
                Value::Null,
            )
            .await?;
            Ok(json!({"ok": true}))
        }

        "startSession" => {
            let p = v.get("params").cloned().unwrap_or(json!({}));
            let cwd = p
                .get("cwd")
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .to_string();
            if cwd.is_empty() {
                return Err("cwd is required".into());
            }
            let gs = |k: &str| p.get(k).and_then(|x| x.as_str()).map(String::from);
            let params = StartSessionParams {
                prompt: gs("prompt").unwrap_or_default(),
                cwd,
                model: gs("model"),
                session_id: None,
                allowed_tools: None,
                resume_session_id: gs("resumeSessionId"),
                thinking_level: gs("thinkingLevel").or_else(|| Some("medium".to_string())),
                session_mode: None,
                provider_id: gs("providerId"),
                permission_mode: gs("permissionMode"),
                model_switch: None,
            };
            let info = crate::start_claude_session_inner(
                ctx.app.clone(),
                ctx.app.state::<ProcessManager>().inner().clone(),
                ctx.app.state::<StdinManager>().inner().clone(),
                ctx.app.state::<BypassModeMap>().inner().clone(),
                ctx.app.state::<PathAccessManager>().inner().clone(),
                params,
            )
            .await?;
            if let Some(pending) = PENDING_TRACK.get() {
                pending.lock().await.push(info.stdin_id.clone());
            }
            serde_json::to_value(&info).map_err(|e| e.to_string())
        }

        other => Err(format!("unknown op: {other}")),
    }
}

/// List immediate subdirectories of `path` (for the phone's cwd picker).
/// Only directories are returned; dotfiles are skipped.
/// The one number the phone needs from ~/.claude/settings.json. Deliberately
/// not the whole `env` object: it also holds ANTHROPIC_AUTH_TOKEN and friends,
/// and this response crosses the network.
fn read_context_settings() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("cannot find home dir")?;
    let path = home.join(".claude").join("settings.json");
    let max = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| {
            v.get("env")
                .and_then(|e| e.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
                .and_then(|x| x.as_str())
                .and_then(|s| s.trim().parse::<u64>().ok())
        })
        .unwrap_or(0);
    Ok(json!({ "maxContextTokens": max }))
}

/// Read a small JSON ledger, falling back to `default` when it is missing or
/// unparsable. These files are written by the desktop too, so a bad read must
/// not take the phone's session list down with it.
fn read_json_file(path: &std::path::Path, default: Value) -> Value {
    let Ok(text) = std::fs::read_to_string(path) else {
        return default;
    };
    serde_json::from_str(&text).unwrap_or(default)
}

fn write_json_file(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Add or remove one id in a JSON array ledger (pinned.json, archived.json).
fn toggle_id_list(path: &std::path::Path, id: &str, add: bool) -> Result<(), String> {
    let mut list = read_json_file(path, json!([]));
    let arr = list.as_array_mut().ok_or("ledger is not an array")?;
    let exists = arr.iter().any(|x| x.as_str() == Some(id));
    if add && !exists {
        arr.push(Value::String(id.to_string()));
    } else if !add && exists {
        arr.retain(|x| x.as_str() != Some(id));
    }
    write_json_file(path, &list)
}

fn list_dir(path: &str) -> Result<Value, String> {
    let p = if path.is_empty() {
        dirs::home_dir().ok_or("cannot find home dir")?
    } else {
        std::path::PathBuf::from(path)
    };
    let mut dirs = vec![];
    let mut file_count = 0usize;
    for entry in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            dirs.push(json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
            }));
        } else {
            file_count += 1;
        }
    }
    dirs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({
        "path": p.to_string_lossy(),
        "parent": p.parent().map(|x| x.to_string_lossy().to_string()),
        "dirs": dirs,
        "fileCount": file_count,
    }))
}

/// Watches the mirrored stream to (a) learn each live process's Claude CLI
/// UUID and (b) register phone-started sessions as tracked once their
/// `system:init` arrives (otherwise the desktop session list would hide them).
async fn event_watcher(mut rx: broadcast::Receiver<RemoteEvent>) {
    loop {
        let ev = match rx.recv().await {
            Ok(ev) => ev,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        };
        let Some(stdin_id) = ev.ev.strip_prefix("claude:stream:") else {
            continue;
        };
        let stdin_id = stdin_id.to_string();

        // Learn / forget the stdin_id → CLI UUID binding.
        if let Some(map) = ACTIVE_MAP.get() {
            if ev.data.get("type").and_then(|t| t.as_str()) == Some("process_exit") {
                map.lock().await.remove(&stdin_id);
            } else if let Some(cli_id) = ev.data.get("session_id").and_then(|v| v.as_str()) {
                let mut m = map.lock().await;
                if m.get(&stdin_id).map(String::as_str) != Some(cli_id) {
                    m.insert(stdin_id.clone(), cli_id.to_string());
                }
            }
        }

        if ev.data.get("type").and_then(|t| t.as_str()) != Some("system")
            || ev.data.get("subtype").and_then(|t| t.as_str()) != Some("init")
        {
            continue;
        }
        let Some(cli_id) = ev.data.get("session_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let cli_id = cli_id.to_string();
        let Some(pending) = PENDING_TRACK.get() else {
            continue;
        };
        let mut lock = pending.lock().await;
        if let Some(pos) = lock.iter().position(|x| x == &stdin_id) {
            lock.remove(pos);
            drop(lock);
            if let Err(e) = crate::track_session_inner(cli_id.clone()).await {
                eprintln!("[remote] failed to track session {cli_id}: {e}");
            } else {
                eprintln!("[remote] tracked phone-started session {cli_id}");
            }
        }
    }
}

/// Start the remote server. Never blocks app startup: any failure is logged
/// and the desktop app continues normally.
pub async fn start(app: AppHandle) {
    let cfg = load_or_create_config();
    if !cfg.enabled {
        eprintln!("[remote] disabled via config");
        return;
    }

    let (tx, _rx) = broadcast::channel::<RemoteEvent>(8192);
    let _ = TX.set(tx.clone());
    let _ = PENDING_TRACK.set(Arc::new(Mutex::new(Vec::new())));
    let _ = ACTIVE_MAP.set(Arc::new(Mutex::new(HashMap::new())));
    tokio::spawn(event_watcher(tx.subscribe()));

    let ctx = Ctx {
        app,
        token: Arc::new(RwLock::new(cfg.token.clone())),
        tx,
        mobile_html: cfg.mobile_html.clone(),
    };
    watch_config(ctx.clone());
    let router = Router::new()
        .route("/", get(root_handler))
        .route("/ws", get(ws_handler))
        .with_state(ctx);

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let loopback = format!("127.0.0.1:{}", cfg.port);

    let mut listeners: Vec<tokio::net::TcpListener> = Vec::new();
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => {
            eprintln!("[remote] listening on {addr}");
            listeners.push(l);
        }
        Err(e) => eprintln!("[remote] bind {addr} failed: {e}"),
    }
    // Also serve on loopback so a desktop browser can reach it via localhost.
    if addr != loopback {
        match tokio::net::TcpListener::bind(&loopback).await {
            Ok(l) => {
                eprintln!("[remote] listening on {loopback}");
                listeners.push(l);
            }
            Err(e) => eprintln!("[remote] bind {loopback} failed: {e}"),
        }
    }

    if listeners.is_empty() {
        eprintln!("[remote] no listener bound; remote disabled");
        return;
    }

    let mut servers = Vec::new();
    for listener in listeners {
        let router = router.clone();
        servers.push(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("[remote] server error: {e}");
            }
        }));
    }
    for s in servers {
        let _ = s.await;
    }
}

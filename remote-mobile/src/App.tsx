import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { RemoteClient, type ConnStatus } from "./protocol";
import { loadConfig, saveConfig, parseLink, type RemoteConfig } from "./config";
import { isEnabled, isNative, onOpenSession, reportContext, restart, setEnabled } from "./keepalive";
import {
  SessionModel,
  parseHistory,
  toolLabel,
  toolSummary,
  type Block,
  type Msg,
  type TodoItem,
  type UserQuestion,
} from "./model";
import {
  COLOR_THEMES,
  FONT_MAX,
  FONT_MIN,
  THEME_MODES,
  isDarkResolved,
  useAppearance,
  type Appearance,
} from "./theme";
import {
  AiMark,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  CornerUpLeft,
  Dots,
  Folder,
  Loader,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Sparkle,
  StopSquare,
  Wrench,
  X,
} from "./icons";

interface SessionEntry {
  id: string; // Claude CLI session UUID
  path: string; // jsonl path
  project: string;
  projectDir: string;
  preview: string;
  modifiedAt: number;
}

interface ActiveEntry {
  stdinId: string;
  cliSessionId: string | null;
}

/** Names, pins and archives, all kept in small JSON ledgers on the host. */
interface SessionMeta {
  customPreviews: Record<string, string>;
  pinned: string[];
  archived: string[];
}

/** A question raised by a session other than the one on screen. */
interface PendingAsk {
  stdinId: string;
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: any;
  description?: string;
  at: number;
}

interface RecentProject {
  name: string;
  path: string;
  shortPath: string;
  lastUsed: number;
}

interface ProviderInfo {
  id: string;
  name: string;
  modelMappings?: { tier: string; providerModel: string }[];
}

type View = { name: "sessions" } | { name: "chat" } | { name: "new" };

export default function App() {
  const [cfg, setCfg] = useState<RemoteConfig>(loadConfig);
  const [showSetup, setShowSetup] = useState(false);
  const clientRef = useRef<RemoteClient | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [appearance, setAppearance] = useAppearance();
  const [keepAlive, setKeepAlive] = useState(isEnabled);
  const [view, setView] = useState<View>({ name: "sessions" });
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [active, setActive] = useState<Map<string, string | null>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Questions raised by a session that is not the one on screen. Without this
  // they would be dropped by the routing filter below and the phone would sit
  // silent while the CLI waits for an answer.
  const [pendings, setPendings] = useState<PendingAsk[]>([]);
  const [asksCollapsed, setAsksCollapsed] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({
    customPreviews: {},
    pinned: [],
    archived: [],
  });
  const [query, setQuery] = useState("");
  const [chatMenu, setChatMenu] = useState(false);
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS from the host's settings.json. The CLI uses
  // it as the window for every model it spawns, proxied ids included, so the
  // Ctx percentage has to divide by it instead of guessing 200K.
  const [maxContextTokens, setMaxContextTokens] = useState(0);

  const modelRef = useRef<SessionModel>(new SessionModel());
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const cur = useRef<{ entry: SessionEntry | null; cwd: string }>({ entry: null, cwd: "" });

  const applyCfg = useCallback((next: RemoteConfig) => {
    setCfg(saveConfig(next));
    setShowSetup(false);
  }, []);

  /** Answer a permission control_request. `updatedInput` carries the answers map
   *  for AskUserQuestion and the untouched tool input for everything else. */
  const callPermission = useCallback(
    async (
      stdinId: string,
      requestId: string,
      allow: boolean,
      opts: { toolUseId?: string; updatedInput?: any; message?: string } = {},
    ) => {
      const c = clientRef.current;
      if (!c) throw new Error("未连接");
      if (!stdinId) throw new Error("该会话当前不在运行");
      await c.call("permission", {
        sessionId: stdinId,
        requestId,
        allow,
        toolUseId: opts.toolUseId,
        updatedInput: opts.updatedInput,
        message: opts.message,
      });
    },
    [],
  );

  /** Answer a question raised by a session the phone is not showing. */
  const answerPending = async (
    requestId: string,
    toolUseId: string | undefined,
    baseInput: any,
    answers: Record<string, string>,
  ) => {
    const p = pendings.find((x) => x.requestId === requestId);
    if (!p) return;
    try {
      await callPermission(p.stdinId, requestId, true, {
        toolUseId,
        updatedInput: { ...baseInput, answers },
      });
      setPendings((prev) => prev.filter((x) => x.requestId !== requestId));
    } catch (e: any) {
      alert("提交失败：" + String(e?.message || e));
    }
  };

  const allowPending = async (p: PendingAsk, allow: boolean) => {
    try {
      await callPermission(p.stdinId, p.requestId, allow, {
        toolUseId: p.toolUseId,
        updatedInput: allow ? p.input : undefined,
        message: allow ? undefined : "用户从手机拒绝",
      });
      setPendings((prev) => prev.filter((x) => x.requestId !== p.requestId));
    } catch (e: any) {
      alert("操作失败：" + String(e?.message || e));
    }
  };

  // Point the native service at the saved host whenever the settings change.
  useEffect(() => {
    void restart(cfg);
  }, [cfg]);

  const toggleKeepAlive = useCallback(
    async (enabled: boolean) => {
      setKeepAlive(await setEnabled(enabled, cfg));
    },
    [cfg],
  );

  // Tell the service which session is on screen so it stays quiet for a
  // completion the user is already watching. Skipped when nothing changed.
  const reported = useRef("");
  useEffect(() => {
    if (!isNative() || !keepAlive) return;
    const push = () => {
      const stdinId = view.name === "chat" ? modelRef.current.stdinId : null;
      const foreground = document.visibilityState === "visible";
      const key = `${stdinId ?? ""}|${foreground}`;
      if (key === reported.current) return;
      reported.current = key;
      void reportContext(stdinId, foreground);
    };
    push();
    const t = window.setInterval(push, 5000);
    document.addEventListener("visibilitychange", push);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", push);
    };
  }, [view.name, keepAlive]);

  // --- connection ----------------------------------------------------------
  useEffect(() => {
    if (!cfg.token) return;
    const c = new RemoteClient(cfg.base, cfg.token);
    clientRef.current = c;
    const offStatus = c.onStatus(setStatus);
    const offEvent = c.onEvent(({ ev, data }) => {
      const cliId = typeof data?.session_id === "string" ? data.session_id : null;
      const stdinId = ev.startsWith("claude:stream:") ? ev.slice("claude:stream:".length) : null;
      if (ev === "sessions:changed") {
        void refreshList();
        return;
      }
      if (ev === "permission:resolved") {
        // Answered on the desktop (or mirrored back after this phone answered).
        const rid = typeof data?.requestId === "string" ? data.requestId : null;
        if (rid) {
          setPendings((prev) => prev.filter((p) => p.requestId !== rid));
          modelRef.current.resolvePermission(rid, data?.allow !== false);
          rerender();
        }
        return;
      }
      if (!stdinId) return;
      const m = modelRef.current;
      const matches =
        (m.stdinId && stdinId === m.stdinId) ||
        (cliId && m.cliSessionId && cliId === m.cliSessionId);
      if (!matches) {
        // Would otherwise be dropped: the session on screen is not the one
        // asking. Keep the question so it can still be answered from the sheet.
        if (data?.type === "tokenicode_permission_request" && data.request_id) {
          setPendings((prev) =>
            prev.some((p) => p.requestId === data.request_id)
              ? prev
              : [
                  ...prev,
                  {
                    stdinId,
                    requestId: data.request_id,
                    toolName: data.tool_name || "AskUserQuestion",
                    toolUseId: data.tool_use_id,
                    input: data.input,
                    description: data.description,
                    at: Date.now(),
                  },
                ],
          );
        }
        return;
      }
      if (!m.cliSessionId && cliId) m.cliSessionId = cliId;
      if (!m.stdinId) m.stdinId = stdinId;
      modelRef.current.applyEvent(ev, data);
      rerender();
    });
    c.connect();
    return () => {
      offStatus();
      offEvent();
      c.close();
    };
    // refreshList is a stable useCallback; referencing it here keeps the
    // subscription from re-registering on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, rerender]);

  // The full transcript listing reads every session file on the host, so it is
  // the expensive half of a refresh. On a 2-6s round trip it cannot be fired
  // every 5s without piling up, so it is guarded against overlap and driven by
  // the `sessions:changed` broadcast plus explicit user actions.
  const listBusy = useRef(false);
  const refreshList = useCallback(async () => {
    const c = clientRef.current;
    if (!c || listBusy.current) return;
    listBusy.current = true;
    try {
      const list = await c.call<SessionEntry[]>("listSessions");
      setSessions(list);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      listBusy.current = false;
    }
  }, []);

  // listActive is answered from memory on the host, so this is the cheap half
  // and is safe to poll on a short interval.
  const activeBusy = useRef(false);
  const refreshActive = useCallback(async () => {
    const c = clientRef.current;
    if (!c || activeBusy.current) return;
    activeBusy.current = true;
    try {
      const act = await c.call<ActiveEntry[]>("listActive");
      const m = new Map<string, string | null>();
      for (const a of act) if (a.cliSessionId) m.set(a.cliSessionId, a.stdinId);
      setActive(m);
    } catch {
      /* ignore */
    } finally {
      activeBusy.current = false;
    }
  }, []);

  /** Names, pins and archives are cosmetic: if the ledgers cannot be read the
   *  list still has to render, so failures are swallowed. */
  const refreshMeta = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const m = await c.call<SessionMeta>("sessionMeta");
      setSessionMeta({
        customPreviews:
          m?.customPreviews && typeof m.customPreviews === "object" ? m.customPreviews : {},
        pinned: Array.isArray(m?.pinned) ? m.pinned : [],
        archived: Array.isArray(m?.archived) ? m.archived : [],
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    await Promise.all([refreshList(), refreshActive(), refreshMeta()]);
  }, [refreshList, refreshActive, refreshMeta]);

  useEffect(() => {
    if (status !== "open") return;
    clientRef.current
      ?.call<{ maxContextTokens: number }>("contextSettings")
      .then((r) => {
        const n = Number(r?.maxContextTokens);
        if (Number.isFinite(n) && n > 0) setMaxContextTokens(n);
      })
      .catch(() => {
        /* older hosts do not have this op; the absolute token count still shows */
      });
  }, [status]);

  useEffect(() => {
    if (status === "open") void refreshSessions();
  }, [status, refreshSessions]);

  // Poll active processes so "running" badges stay fresh. Only the cheap half
  // runs on a timer; the session list rides the `sessions:changed` broadcast.
  useEffect(() => {
    if (status !== "open") return;
    const t = window.setInterval(() => void refreshActive(), 5000);
    return () => clearInterval(t);
  }, [status, refreshActive]);

  // --- opening a session ---------------------------------------------------
  const openSession = useCallback(
    async (entry: SessionEntry) => {
      const c = clientRef.current;
      if (!c) return;
      const m = new SessionModel();
      modelRef.current = m;
      m.cliSessionId = entry.id;
      m.stdinId = active.get(entry.id) ?? null;
      m.resumeCwd = entry.project;
      cur.current = { entry, cwd: entry.project };
      setView({ name: "chat" });
      rerender();
      try {
        const raw = await c.call<any[]>("loadSession", { path: entry.path });
        const hist = parseHistory(raw);
        m.messages = hist.messages;
        m.contextTokens = hist.contextTokens;
        if (hist.model) m.model = hist.model;
        rerender();
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    },
    [active, rerender],
  );

  const closeChat = useCallback(() => {
    modelRef.current = new SessionModel();
    setView({ name: "sessions" });
    void refreshSessions();
  }, [refreshSessions]);

  // --- session management --------------------------------------------------
  const renameSession = async (entry: SessionEntry, name: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.call("renameSession", { sessionId: entry.id, name });
      await refreshMeta();
    } catch (e: any) {
      alert("重命名失败：" + String(e?.message || e));
    }
  };

  const pinSession = async (entry: SessionEntry, pinned: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.call("pinSession", { sessionId: entry.id, pinned });
      await refreshMeta();
    } catch (e: any) {
      alert("置顶失败：" + String(e?.message || e));
    }
  };

  const archiveSession = async (entry: SessionEntry, archived: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.call("archiveSession", { sessionId: entry.id, archived });
      await refreshMeta();
    } catch (e: any) {
      alert("归档失败：" + String(e?.message || e));
    }
  };

  const deleteSession = async (entry: SessionEntry) => {
    const c = clientRef.current;
    if (!c) return;
    if (!window.confirm("删除这个会话？会话文件会被删掉，无法恢复。")) return;
    try {
      await c.call("deleteSession", { sessionId: entry.id, path: entry.path });
      await refreshSessions();
    } catch (e: any) {
      alert("删除失败：" + String(e?.message || e));
    }
  };

  const exportSession = async (entry: SessionEntry) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const raw = await c.call<any[]>("loadSession", { path: entry.path, maxBytes: 1_500_000 });
      const { messages } = parseHistory(raw);
      await copyText(messagesToMarkdown(messages));
      alert("已复制为 Markdown");
    } catch (e: any) {
      alert("导出失败：" + String(e?.message || e));
    }
  };

  // --- opening a session from a notification -------------------------------
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);

  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void onOpenSession((id) => setPendingOpen(id)).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Held until the list arrives so a cold start from a notification still lands
  // on the right session. Newer notifications carry the CLI session id, which
  // matches a row directly; anything else carries the stdin id, which the
  // active map resolves.
  useEffect(() => {
    if (!pendingOpen || sessions.length === 0) return;
    const entry =
      sessions.find((s) => s.id === pendingOpen) ??
      sessions.find((s) => active.get(s.id) === pendingOpen);
    if (!entry) return;
    setPendingOpen(null);
    void openSession(entry);
  }, [pendingOpen, sessions, active, openSession]);

  // Session rows whose CLI id maps to a stdin_id that has a question waiting.
  // `active` runs cliSessionId → stdinId; invert it so the list can flag the row.
  const awaitingIds = new Set<string>();
  if (pendings.length > 0) {
    const want = new Set(pendings.map((p) => p.stdinId));
    for (const [cliId, stdinId] of active) {
      if (stdinId && want.has(stdinId)) awaitingIds.add(cliId);
    }
  }

  if (!cfg.token || showSetup) {
    return (
      <div className="app">
        <TopBar status={status} title={showSetup ? "设置" : "TOKENICODE"} />
        <Setup
          initial={cfg}
          appearance={appearance}
          onAppearance={setAppearance}
          onSave={applyCfg}
          keepAlive={keepAlive}
          onKeepAlive={toggleKeepAlive}
          onCancel={cfg.token ? () => setShowSetup(false) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        status={status}
        title={view.name === "chat" ? cur.current.entry?.project || "会话" : view.name === "new" ? "新建会话" : "TOKENICODE"}
        onBack={view.name === "sessions" ? undefined : closeChat}
        onNew={view.name === "sessions" ? () => setView({ name: "new" }) : undefined}
        onRefresh={view.name === "sessions" ? refreshSessions : undefined}
        onSettings={
          view.name === "sessions"
            ? () => setShowSetup(true)
            : view.name === "chat" && clientRef.current
              ? () => setChatMenu(true)
              : undefined
        }
      />
      {error && <div className="err">{error}</div>}
      {view.name === "sessions" && (
        <SessionList
          sessions={sessions}
          active={active}
          awaiting={awaitingIds}
          meta={sessionMeta}
          query={query}
          onQuery={setQuery}
          onOpen={openSession}
          onNew={() => setView({ name: "new" })}
          onRename={renameSession}
          onPin={pinSession}
          onArchive={archiveSession}
          onDelete={deleteSession}
          onExport={exportSession}
          disconnected={status !== "open"}
        />
      )}
      {view.name === "chat" && (
        <ChatView
          model={modelRef.current}
          client={clientRef.current!}
          rerender={rerender}
          onSent={rerender}
          callPermission={callPermission}
          configuredWindow={maxContextTokens}
        />
      )}
      {view.name === "new" && (
        <NewSession
          client={clientRef.current!}
          onCancel={() => setView({ name: "sessions" })}
          onCreated={async (entry, stdinId, cliId, firstMessage, opts) => {
            const m = new SessionModel();
            modelRef.current = m;
            m.stdinId = stdinId;
            m.cliSessionId = cliId;
            m.status = "streaming";
            m.resumeCwd = entry.projectDir;
            m.resumeModel = opts.model;
            m.resumeProviderId = opts.providerId;
            m.resumePermissionMode = opts.mode;
            if (opts.model) m.model = opts.model;
            if (firstMessage) m.addUserMessage(firstMessage);
            cur.current = { entry, cwd: entry.projectDir };
            setView({ name: "chat" });
            rerender();
          }}
        />
      )}
      {pendings.length > 0 && (
        <div className={"asks" + (asksCollapsed ? " collapsed" : "")}>
          <button className="asks-head" onClick={() => setAsksCollapsed((c) => !c)}>
            <ShieldAlert size={15} />
            <span>需要你选择 · {pendings.length}</span>
            <ChevronDown size={15} className={"asks-chev" + (asksCollapsed ? "" : " flip")} />
          </button>
          {!asksCollapsed && (
            <div className="asks-body">
              {pendings.map((p) => (
                <PendingItem
                  key={p.requestId}
                  ask={p}
                  onAnswer={answerPending}
                  onAllow={allowPending}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {view.name === "chat" && chatMenu && clientRef.current && (
        <ChatSettingsSheet
          model={modelRef.current}
          client={clientRef.current}
          onClose={() => setChatMenu(false)}
          onChanged={rerender}
        />
      )}
    </div>
  );
}

// --- top bar ---------------------------------------------------------------

function TopBar(props: {
  status: ConnStatus;
  title: string;
  onBack?: () => void;
  onNew?: () => void;
  onRefresh?: () => void;
  onSettings?: () => void;
}) {
  return (
    <div className="topbar">
      {props.onBack && (
        <button className="iconbtn" onClick={props.onBack} title="返回">
          <ChevronLeft size={20} />
        </button>
      )}
      <span className={"dot " + (props.status === "open" ? "open" : props.status === "connecting" ? "connecting" : "")} />
      <div className="title">{props.title}</div>
      {props.onNew && (
        <button className="iconbtn" onClick={props.onNew} title="新建会话">
          <Plus size={18} />
        </button>
      )}
      {props.onRefresh && (
        <button className="iconbtn" onClick={props.onRefresh} title="刷新">
          <RefreshCw size={16} />
        </button>
      )}
      {props.onSettings && (
        <button className="iconbtn" onClick={props.onSettings} title="设置">
          <Settings size={17} />
        </button>
      )}
    </div>
  );
}

// --- per-session settings --------------------------------------------------

/**
 * Mode and model for the session on screen. Mode switches at runtime ride the
 * SDK control protocol (`set_permission_mode`), except the move INTO bypass —
 * the CLI only enters that mode from a launch flag, so it is stored and applied
 * the next time the session is resumed.
 */
function ChatSettingsSheet(props: {
  model: SessionModel;
  client: RemoteClient;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { model, client } = props;
  const [models, setModels] = useState<string[]>([]);
  const [mode, setMode] = useState(model.resumePermissionMode || "bypassPermissions");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .call<any>("listProviders")
      .then((p) => {
        if (!alive) return;
        const list: ProviderInfo[] = p?.providers || [];
        const activeId = p?.activeProviderId || list[0]?.id || "";
        const active = list.find((x) => x.id === activeId) || list[0];
        const names = Array.from(
          new Set((active?.modelMappings || []).map((m) => m.providerModel).filter(Boolean)),
        );
        setModels(names);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  const applyMode = async (next: "bypassPermissions" | "default" | "plan") => {
    setMode(next);
    model.resumePermissionMode = next;
    if (!model.stdinId) return;
    if (next === "bypassPermissions") {
      alert("自动模式只能在启动时进入，下次恢复这个会话时生效。");
      return;
    }
    try {
      await client.call("setPermissionMode", { sessionId: model.stdinId, mode: next });
      props.onChanged();
    } catch (e: any) {
      alert("切换模式失败：" + String(e?.message || e));
    }
  };

  const applyModel = async (id: string) => {
    model.resumeModel = id;
    if (!model.stdinId) return;
    setBusy(true);
    try {
      await client.call("setModel", { sessionId: model.stdinId, model: id });
      props.onChanged();
    } catch (e: any) {
      alert("切换模型失败：" + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const current = model.model || model.resumeModel;

  return (
    <div className="sheet-mask" onClick={props.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">会话设置</div>
        <div className="sheet-label">权限模式</div>
        <div className="seg sheet-seg">
          {(
            [
              ["bypassPermissions", "自动"],
              ["default", "询问"],
              ["plan", "计划"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className={mode === value ? "on" : ""} onClick={() => applyMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {models.length > 0 && (
          <>
            <div className="sheet-label">模型</div>
            <div className="sheet-list">
              {models.map((m) => (
                <button
                  key={m}
                  className={"sheet-row" + (m === current ? " on" : "")}
                  onClick={() => applyModel(m)}
                >
                  <span>{m}</span>
                  {m === current && <Check size={14} />}
                </button>
              ))}
            </div>
          </>
        )}
        {busy && <div className="sheet-hint">切换中…</div>}
        <button className="ghost" onClick={props.onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

/** Copy helper shared by the message button and the markdown export. */
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

/** Flatten a parsed transcript into markdown, for the phone's export action. */
function messagesToMarkdown(messages: Msg[]): string {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.t === "text") {
        out.push(m.role === "user" ? `## 用户\n\n${b.text}` : b.text);
      } else if (b.t === "tool") {
        const summary = toolSummary(b.name, b.input);
        out.push(`> \`${toolLabel(b.name)}\`${summary ? " " + summary : ""}`);
      } else if (b.t === "image") {
        out.push("![图片]");
      }
    }
  }
  return out.join("\n\n");
}

// --- session list ----------------------------------------------------------

function SessionList(props: {
  sessions: SessionEntry[];
  active: Map<string, string | null>;
  /** CLI session ids with a question waiting for an answer. */
  awaiting: Set<string>;
  meta: SessionMeta;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (s: SessionEntry) => void;
  onNew: () => void;
  onRename: (s: SessionEntry, name: string) => void;
  onPin: (s: SessionEntry, pinned: boolean) => void;
  onArchive: (s: SessionEntry, archived: boolean) => void;
  onDelete: (s: SessionEntry) => void;
  onExport: (s: SessionEntry) => void;
  disconnected: boolean;
}) {
  const [menuFor, setMenuFor] = useState<SessionEntry | null>(null);
  const [renaming, setRenaming] = useState<{ entry: SessionEntry; initial: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const nameOf = (s: SessionEntry) => props.meta.customPreviews[s.id] || s.preview || "";
  const q = props.query.trim().toLowerCase();
  const visible = q
    ? props.sessions.filter(
        (s) => nameOf(s).toLowerCase().includes(q) || s.project.toLowerCase().includes(q),
      )
    : props.sessions;
  const isPinned = (s: SessionEntry) => props.meta.pinned.includes(s.id);
  const isArchived = (s: SessionEntry) => props.meta.archived.includes(s.id);
  const pinned = visible.filter(isPinned);
  const normal = visible.filter((s) => !isPinned(s) && !isArchived(s));
  const archived = visible.filter((s) => !isPinned(s) && isArchived(s));

  if (props.disconnected && props.sessions.length === 0) {
    return (
      <div className="scroll">
        <div className="loading">
          <Loader size={15} />
          <span>连接中…</span>
        </div>
      </div>
    );
  }

  const row = (s: SessionEntry) => {
    const running = props.active.has(s.id);
    const awaiting = props.awaiting.has(s.id);
    const arc = isArchived(s);
    return (
      <div
        key={s.id}
        className={"session" + (awaiting ? " awaiting" : "") + (arc ? " archived" : "")}
        onClick={() => props.onOpen(s)}
      >
        {running && <span className={"bar" + (awaiting ? " ask" : "")} />}
        <div className="name">{baseName(s.project) || "(未知项目)"}</div>
        <div className="preview">{nameOf(s) || "（空会话）"}</div>
        <div className="meta">
          {awaiting && <span className="badge ask">等你选择</span>}
          {running && <span className="badge">运行中</span>}
          <span>{relTime(s.modifiedAt)}</span>
        </div>
        <button
          className="rowmenu"
          onClick={(e) => {
            e.stopPropagation();
            setMenuFor(s);
          }}
          title="更多"
        >
          <Dots size={16} />
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="searchbar">
        <Search size={15} />
        <input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="搜索标题或项目"
        />
        {props.query && (
          <button className="clearbtn" onClick={() => props.onQuery("")} title="清除">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="scroll">
        {props.sessions.length === 0 && (
          <div className="empty">
            还没有会话。
            <br />
            <button className="primary" style={{ marginTop: 16 }} onClick={props.onNew}>
              <Plus size={15} />
              从手机新建一个
            </button>
          </div>
        )}
        {props.sessions.length > 0 && visible.length === 0 && (
          <div className="empty">没有匹配的会话</div>
        )}
        <div className="list">
          {pinned.map(row)}
          {normal.map(row)}
        </div>
        {archived.length > 0 && (
          <div className="archive-group">
            <button className="archive-head" onClick={() => setShowArchived((v) => !v)}>
              <ChevronDown size={13} className={"tool-chev" + (showArchived ? " open" : "")} />
              已归档 · {archived.length}
            </button>
            {showArchived && <div className="list">{archived.map(row)}</div>}
          </div>
        )}
      </div>
      {menuFor && (
        <div className="sheet-mask" onClick={() => setMenuFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{nameOf(menuFor) || "（空会话）"}</div>
            <button
              onClick={() => {
                setRenaming({
                  entry: menuFor,
                  initial: props.meta.customPreviews[menuFor.id] || "",
                });
                setMenuFor(null);
              }}
            >
              重命名
            </button>
            <button
              onClick={() => {
                props.onPin(menuFor, !isPinned(menuFor));
                setMenuFor(null);
              }}
            >
              {isPinned(menuFor) ? "取消置顶" : "置顶"}
            </button>
            <button
              onClick={() => {
                props.onArchive(menuFor, !isArchived(menuFor));
                setMenuFor(null);
              }}
            >
              {isArchived(menuFor) ? "取消归档" : "归档"}
            </button>
            <button
              onClick={() => {
                props.onExport(menuFor);
                setMenuFor(null);
              }}
            >
              导出为 Markdown
            </button>
            <button
              className="danger"
              onClick={() => {
                props.onDelete(menuFor);
                setMenuFor(null);
              }}
            >
              删除
            </button>
            <button className="ghost" onClick={() => setMenuFor(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {renaming && (
        <RenameDialog
          initial={renaming.initial}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => {
            props.onRename(renaming.entry, name);
            setRenaming(null);
          }}
        />
      )}
    </>
  );
}

/** Small modal for renaming a session; empty input restores the preview. */
function RenameDialog(props: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <div className="sheet-mask" onClick={props.onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">重命名会话</div>
        <input
          className="sheet-input"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          placeholder="留空恢复原标题"
        />
        <button className="primary" onClick={() => props.onSubmit(value.trim())}>
          保存
        </button>
        <button className="ghost" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// --- chat ------------------------------------------------------------------

function ChatView(props: {
  model: SessionModel;
  client: RemoteClient;
  rerender: () => void;
  onSent: () => void;
  /** CLAUDE_CODE_MAX_CONTEXT_TOKENS from the host, 0 when unset. */
  configuredWindow: number;
  callPermission: (
    stdinId: string,
    requestId: string,
    allow: boolean,
    opts?: { toolUseId?: string; updatedInput?: any; message?: string },
  ) => Promise<void>;
}) {
  const { model, client, rerender } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const sendNow = async (text: string, queuedMsg?: Msg) => {
    const m = model;
    if (!m.stdinId) {
      // Idle session — resume it first so we get a live process.
      if (!m.resumeCwd) {
        alert("无法恢复：缺少工作目录");
        return;
      }
      try {
        const info = await client.call<any>("startSession", {
          params: {
            cwd: m.resumeCwd || "",
            resumeSessionId: m.cliSessionId,
            providerId: m.resumeProviderId || undefined,
            model: m.resumeModel || undefined,
            permissionMode: m.resumePermissionMode || "bypassPermissions",
          },
        });
        m.stdinId = info.stdin_id;
        if (info.cli_session_id) m.cliSessionId = info.cli_session_id;
      } catch (e: any) {
        alert("恢复会话失败：" + String(e?.message || e));
        return;
      }
    }
    if (queuedMsg) {
      queuedMsg.pending = true;
      queuedMsg.queued = false;
    } else {
      m.addUserMessage(text);
    }
    m.status = "streaming";
    m.turnStartedAt = Date.now();
    rerender();
    try {
      await client.call("send", { sessionId: m.stdinId, message: text });
    } catch (e: any) {
      alert("发送失败：" + String(e?.message || e));
    }
  };

  /** A send while a turn is running is queued rather than refused: the phone
   *  often types the follow-up before the answer finishes. The queue drains on
   *  the next `result` (status flips back to idle). */
  const send = (text: string) => {
    const m = model;
    if (m.status === "streaming") {
      m.queue.push(text);
      m.messages.push({
        id: `q-${Date.now()}-${m.messages.length}`,
        role: "user",
        blocks: [{ t: "text", text }],
        ts: Date.now(),
        queued: true,
      });
      rerender();
      return;
    }
    void sendNow(text);
  };

  const draining = useRef(false);
  useEffect(() => {
    const m = model;
    if (m.status !== "idle" || m.queue.length === 0 || draining.current) return;
    const text = m.queue.shift()!;
    const queuedMsg = m.messages.find((x) => x.queued);
    draining.current = true;
    void sendNow(text, queuedMsg).finally(() => {
      draining.current = false;
    });
  });

  const interrupt = async () => {
    if (!model.stdinId) return;
    try {
      await client.call("interrupt", { sessionId: model.stdinId });
    } catch (e: any) {
      alert("中断失败：" + String(e?.message || e));
    }
  };

  const resolvePerm = async (requestId: string, allow: boolean, input?: any, toolUseId?: string) => {
    const stdinId = model.stdinId;
    if (!stdinId) {
      alert("该会话当前不在运行，无法回应。");
      return;
    }
    try {
      await props.callPermission(stdinId, requestId, allow, {
        toolUseId,
        updatedInput: allow ? input : undefined,
        message: allow ? undefined : "用户从手机拒绝",
      });
      model.resolvePermission(requestId, allow);
      rerender();
    } catch (e: any) {
      alert("操作失败：" + String(e?.message || e));
    }
  };

  const answerQuestion: AnswerHandler = async (requestId, toolUseId, baseInput, answers) => {
    const stdinId = model.stdinId;
    if (!stdinId) {
      alert("该会话当前不在运行，无法提交答案。");
      return;
    }
    const readout = Object.values(answers).join(" / ");
    try {
      await props.callPermission(stdinId, requestId, true, {
        toolUseId,
        updatedInput: { ...baseInput, answers },
      });
      model.resolvePermission(requestId, true, readout);
      rerender();
    } catch (e: any) {
      alert("提交失败：" + String(e?.message || e));
    }
  };

  const running = model.status === "streaming";

  // The elapsed time in the status bar has to move while a turn is running,
  // and the only clock in this view is a re-render.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Runs of 3+ consecutive tool calls collapse into one row, matching the
  // desktop's ChatPanel/ToolGroup split. Computed inline rather than memoised:
  // the model mutates its message array in place, so the identity never changes
  // and a memo would never fire.
  const items: DisplayItem[] = [];
  for (let i = 0; i < model.messages.length; ) {
    if (isToolMsg(model.messages[i])) {
      let j = i;
      while (j < model.messages.length && isToolMsg(model.messages[j])) j++;
      if (j - i >= 3) {
        items.push({ kind: "tools", msgs: model.messages.slice(i, j) });
        i = j;
        continue;
      }
    }
    items.push({ kind: "msg", idx: i });
    i++;
  }

  return (
    <>
      <StatsBar model={model} running={running} configuredWindow={props.configuredWindow} />
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat">
          {items.map((item) =>
            item.kind === "tools" ? (
              <ToolGroupView key={item.msgs[0].id} msgs={item.msgs} />
            ) : (
              <MessageView
                key={model.messages[item.idx].id}
                msg={model.messages[item.idx]}
                showAvatar={showsAvatar(model.messages, item.idx)}
                onPerm={resolvePerm}
                onAnswer={answerQuestion}
              />
            ),
          )}
          {running && <div className="msg system">正在生成…</div>}
          {model.result && (
            <div className="msg system">
              {model.result.isError ? "已结束（错误）" : "已完成"}
              {typeof model.result.durationMs === "number" && ` · ${(model.result.durationMs / 1000).toFixed(1)}s`}
              {typeof model.result.costUsd === "number" && ` · $${model.result.costUsd.toFixed(4)}`}
            </div>
          )}
        </div>
      </div>
      <div className="inputbar">
        <div className="input-wrap">
          <InputBox onSend={send} running={running} onStop={interrupt} />
        </div>
      </div>
    </>
  );
}

/**
 * Strip under the top bar carrying the numbers the desktop puts in ChatPanel's
 * header: the model the CLI actually spawned, window occupancy, output tokens,
 * session cost, elapsed time. The window comes from `result.modelUsage`; until
 * the first result arrives the occupancy is shown as an absolute count rather
 * than a percentage against a guessed denominator.
 */
function StatsBar(props: { model: SessionModel; running: boolean; configuredWindow: number }) {
  const { model, running } = props;
  // Window order matches the desktop: what the CLI reported, then the
  // configured CLAUDE_CODE_MAX_CONTEXT_TOKENS, then nothing (absolute count).
  const window = model.contextWindow > 0 ? model.contextWindow : props.configuredWindow;
  const pct = window > 0
    ? Math.min(100, Math.round((model.contextTokens / window) * 100))
    : 0;
  const elapsedMs = running && model.turnStartedAt
    ? Date.now() - model.turnStartedAt
    : model.result?.durationMs;
  const empty = !model.model && model.contextTokens <= 0 && !model.outputTokens && !model.costUsd;
  return (
    <div className={"stats" + (empty ? " empty" : "")}>
      {model.model && (
        <span className="stat model" title={model.model}>
          {shortModel(model.model)}
        </span>
      )}
      {model.contextTokens > 0 && (
        <span
          className={"stat ctx" + (pct >= 90 ? " hot" : pct >= 60 ? " warm" : "")}
          title={`${model.contextTokens} / ${window > 0 ? window : "未知"}`}
        >
          Ctx {window > 0 ? `${pct}%` : fmtTokens(model.contextTokens)}
          {window > 0 && (
            <span className="stat-sub">
              {fmtTokens(model.contextTokens)}/{fmtTokens(window)}
            </span>
          )}
        </span>
      )}
      {model.outputTokens > 0 && <span className="stat">↓ {fmtTokens(model.outputTokens)}</span>}
      {model.costUsd > 0 && <span className="stat">${model.costUsd.toFixed(4)}</span>}
      {typeof elapsedMs === "number" && elapsedMs > 0 && (
        <span className="stat time">{(elapsedMs / 1000).toFixed(1)}s</span>
      )}
    </div>
  );
}

function shortModel(id: string): string {
  return id.replace(/\[1m\]$/i, " (1M)").replace(/-1m$/i, " (1M)");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}m`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(n);
}

function hasText(m: Msg): boolean {
  return m.blocks.some((b) => b.t === "text" && b.text.trim().length > 0);
}

/** AskUserQuestion rides in as an ordinary permission request whose input
 *  carries the questions. Everything else (Bash/Edit/…) is a plain allow/deny. */
function questionsOf(block: Extract<Block, { t: "perm" }>): UserQuestion[] | null {
  if (block.toolName !== "AskUserQuestion") return null;
  const qs = block.input?.questions;
  return Array.isArray(qs) && qs.length > 0 ? (qs as UserQuestion[]) : null;
}

/**
 * The CLI keys each answer by the question's full text and expects the chosen
 * labels joined with ", " (free text when "Other" is used). Keying by index or
 * id makes the model report that it received no answer.
 */
function buildAnswersObject(
  questions: UserQuestion[],
  selectedMap: Record<number, Set<number>>,
  useOther: Record<number, boolean>,
  otherText: Record<number, string>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, qIdx) => {
    if (useOther[qIdx] && otherText[qIdx]?.trim()) {
      answers[q.question] = otherText[qIdx].trim();
      return;
    }
    const labels = Array.from(selectedMap[qIdx] || new Set<number>())
      .map((i) => q.options[i]?.label)
      .filter(Boolean);
    if (labels.length) answers[q.question] = labels.join(", ");
  });
  return answers;
}

/**
 * Mirrors the desktop (ChatPanel `isFirstInGroup`): an avatar belongs to the
 * first text-bearing assistant message of a turn, and to nothing else — tool
 * and thinking rows only borrow its indent.
 */
type DisplayItem = { kind: "msg"; idx: number } | { kind: "tools"; msgs: Msg[] };

/** A message that is nothing but tool calls — the unit the desktop groups on.
 *  TodoWrite is excluded: the desktop gives todos their own message type, so a
 *  checklist never disappears into a collapsed tool run. */
function isToolMsg(m: Msg): boolean {
  return (
    m.role === "assistant" &&
    m.blocks.length > 0 &&
    m.blocks.every((b) => b.t === "tool" && b.name !== "TodoWrite")
  );
}

function showsAvatar(messages: Msg[], i: number): boolean {
  const m = messages[i];
  if (m.role !== "assistant" || !hasText(m)) return false;
  for (let j = i - 1; j >= 0; j--) {
    const prev = messages[j];
    if (prev.role === "user") break;
    if (prev.role === "assistant" && hasText(prev)) return false;
  }
  return true;
}

type PermBlock = Extract<Block, { t: "perm" }>;
type PermHandler = (requestId: string, allow: boolean, input?: any, toolUseId?: string) => void;
type AnswerHandler = (
  requestId: string,
  toolUseId: string | undefined,
  baseInput: any,
  answers: Record<string, string>,
) => void;

function MessageView(props: {
  msg: Msg;
  showAvatar: boolean;
  onPerm: PermHandler;
  onAnswer: AnswerHandler;
}) {
  const { msg } = props;
  if (msg.role === "system") {
    return <div className="msg system">{blocksText(msg.blocks)}</div>;
  }
  if (msg.role === "user") {
    return (
      <div className="msg user">
        {msg.blocks.map((b, i) => (
          <BlockView key={i} block={b} onPerm={props.onPerm} onAnswer={props.onAnswer} />
        ))}
        {msg.pending && <div className="pending">发送中…</div>}
        {msg.queued && <div className="pending">排队中…</div>}
      </div>
    );
  }
  // Assistant turns carry no bubble — avatar plus full-width markdown.
  return (
    <div className="msg assistant">
      {props.showAvatar ? (
        <div className="avatar">
          <AiMark size={14} />
        </div>
      ) : (
        <div className="avatar-spacer" />
      )}
      <div className="msg-body">
        {msg.blocks.map((b, i) => (
          <BlockView key={i} block={b} onPerm={props.onPerm} onAnswer={props.onAnswer} />
        ))}
      </div>
    </div>
  );
}

function BlockView(props: { block: Block; onPerm: PermHandler; onAnswer: AnswerHandler }) {
  const { block } = props;
  if (block.t === "text") {
    return <Markdown text={block.text} />;
  }
  if (block.t === "thinking") {
    return <Thinking text={block.text} />;
  }
  if (block.t === "image") {
    return <ImageBlock block={block} />;
  }
  if (block.t === "tool") {
    return <ToolCard block={block} />;
  }
  if (block.t === "perm") {
    const questions = questionsOf(block);
    if (questions) {
      return <QuestionCard block={block} questions={questions} onAnswer={props.onAnswer} />;
    }
    if (block.toolName === "ExitPlanMode") {
      return <PlanCard block={block} onPerm={props.onPerm} />;
    }
    const resolved = block.resolved;
    return (
      <div className="perm">
        <div className="perm-head">
          <ShieldAlert size={14} />
          <span>权限请求</span>
          <span className="tool-name">· {toolLabel(block.toolName)}</span>
        </div>
        {block.description && <div className="perm-desc">{block.description}</div>}
        <pre>{safeJson(block.input)}</pre>
        {resolved ? (
          <div className="perm-resolved">{resolved === "allow" ? "已允许" : "已拒绝"}</div>
        ) : (
          <div className="perm-actions">
            <button
              className="primary"
              onClick={() => props.onPerm(block.requestId, true, block.input, block.toolUseId)}
            >
              <Check size={15} />
              允许
            </button>
            <button className="danger" onClick={() => props.onPerm(block.requestId, false, undefined, block.toolUseId)}>
              <X size={15} />
              拒绝
            </button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

/**
 * AskUserQuestion, answered inline in the conversation.
 *
 * The desktop renders this same flow as `QuestionCard`; the payload contract is
 * copied verbatim (answers keyed by question text, multi-select joined with
 * ", ") because the CLI reports "no answer" for any other shape.
 */
function QuestionCard(props: {
  block: PermBlock;
  questions: UserQuestion[];
  onAnswer: AnswerHandler;
}) {
  const { block, questions } = props;
  const total = questions.length;
  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState<Record<number, Set<number>>>({});
  const [useOther, setUseOther] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);

  if (block.resolved) {
    return (
      <div className="perm qcard done">
        <div className="perm-head">
          <ShieldAlert size={14} />
          <span>已选择</span>
        </div>
        <div className="perm-resolved">{block.answer || "已回答"}</div>
      </div>
    );
  }

  const q = questions[idx];
  const multi = !!q?.multiSelect;
  const usingOther = !!useOther[idx];
  const currentSel = sel[idx] || new Set<number>();
  const hasAnswer = usingOther ? !!(otherText[idx] || "").trim() : currentSel.size > 0;
  const isLast = idx >= total - 1;

  const toggle = (optIdx: number) => {
    if (sent) return;
    setUseOther((p) => ({ ...p, [idx]: false }));
    setSel((p) => {
      const next = new Set(p[idx] || []);
      if (multi) {
        if (next.has(optIdx)) next.delete(optIdx);
        else next.add(optIdx);
      } else {
        next.clear();
        next.add(optIdx);
      }
      return { ...p, [idx]: next };
    });
  };

  const pickOther = () => {
    if (sent) return;
    setUseOther((p) => ({ ...p, [idx]: !p[idx] }));
    setSel((p) => ({ ...p, [idx]: new Set<number>() }));
  };

  const submit = () => {
    if (!hasAnswer || sent) return;
    setSent(true);
    props.onAnswer(
      block.requestId,
      block.toolUseId,
      block.input,
      buildAnswersObject(questions, sel, useOther, otherText),
    );
  };

  return (
    <div className="perm qcard">
      <div className="perm-head">
        <ShieldAlert size={14} />
        <span>{q?.header || "选择"}</span>
        {total > 1 && (
          <span className="q-progress">
            {idx + 1} / {total}
          </span>
        )}
      </div>
      <div className="q-text">{q?.question}</div>
      <div className="q-options">
        {(q?.options || []).map((opt, i) => {
          const on = !usingOther && currentSel.has(i);
          return (
            <button key={i} className={"q-option" + (on ? " on" : "")} onClick={() => toggle(i)}>
              <span className={"q-tick" + (on ? " on" : "")}>
                {on && <Check size={12} />}
              </span>
              <span className="q-option-body">
                <span className="q-option-label">{opt.label}</span>
                {opt.description && <span className="q-option-desc">{opt.description}</span>}
              </span>
            </button>
          );
        })}
        <button className={"q-option" + (usingOther ? " on" : "")} onClick={pickOther}>
          <span className={"q-tick" + (usingOther ? " on" : "")}>{usingOther && <Check size={12} />}</span>
          <span className="q-option-body">
            <span className="q-option-label">其他</span>
          </span>
        </button>
      </div>
      {usingOther && (
        <textarea
          className="q-other"
          rows={2}
          placeholder="输入你的答案…"
          value={otherText[idx] || ""}
          onChange={(e) => setOtherText((p) => ({ ...p, [idx]: e.target.value }))}
        />
      )}
      <div className="q-actions">
        {idx > 0 && (
          <button className="q-nav" onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            上一题
          </button>
        )}
        {isLast ? (
          <button className="primary q-submit" disabled={!hasAnswer || sent} onClick={submit}>
            {sent ? "已提交" : "提交"}
          </button>
        ) : (
          <button className="primary q-submit" disabled={!hasAnswer} onClick={() => setIdx((i) => i + 1)}>
            下一题
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One outstanding item in the bottom sheet: a question from a session the phone
 * is not showing. AskUserQuestion gets the full option UI; anything else is the
 * usual allow/deny.
 */
function PendingItem(props: {
  ask: PendingAsk;
  onAnswer: AnswerHandler;
  onAllow: (ask: PendingAsk, allow: boolean) => void;
}) {
  const { ask } = props;
  const block: PermBlock = {
    t: "perm",
    requestId: ask.requestId,
    toolName: ask.toolName,
    input: ask.input,
    toolUseId: ask.toolUseId,
    description: ask.description,
  };
  const questions = questionsOf(block);
  if (questions) {
    return <QuestionCard block={block} questions={questions} onAnswer={props.onAnswer} />;
  }
  return (
    <div className="perm">
      <div className="perm-head">
        <ShieldAlert size={14} />
        <span>权限请求</span>
        <span className="tool-name">· {toolLabel(block.toolName)}</span>
      </div>
      {block.description && <div className="perm-desc">{block.description}</div>}
      <pre>{safeJson(block.input)}</pre>
      <div className="perm-actions">
        <button className="primary" onClick={() => props.onAllow(ask, true)}>
          <Check size={15} />
          允许
        </button>
        <button className="danger" onClick={() => props.onAllow(ask, false)}>
          <X size={15} />
          拒绝
        </button>
      </div>
    </div>
  );
}

/** Image blocks arrive as base64 or a URL; both go straight into an <img>. */
function ImageBlock(props: { block: Extract<Block, { t: "image" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        className="msg-img"
        src={props.block.src}
        alt={props.block.alt || "图片"}
        loading="lazy"
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="lightbox" onClick={() => setOpen(false)}>
          <img src={props.block.src} alt={props.block.alt || "图片"} />
        </div>
      )}
    </>
  );
}

/**
 * ExitPlanMode is an ordinary permission request whose payload is a plan the
 * user has to read before approving. The generic card would dump it as JSON,
 * which makes the decision impossible on a phone, so this mirrors the
 * desktop's PlanReviewCard: the plan as markdown, then approve/reject.
 */
function PlanCard(props: { block: PermBlock; onPerm: PermHandler }) {
  const { block } = props;
  const [open, setOpen] = useState(true);
  const plan = typeof block.input?.plan === "string" ? block.input.plan : "";
  const resolved = block.resolved;
  const steps = plan.match(/^\d+\.\s/gm)?.length || 0;
  return (
    <div className={"plan" + (resolved ? " done" : "")}>
      <div className="plan-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} className={"tool-chev" + (open ? " open" : "")} />
        <span className="plan-title">计划审批</span>
        {steps > 0 && <span className="plan-steps">{steps} 步</span>}
        {resolved && <span className="plan-done">{resolved === "allow" ? "已批准" : "已拒绝"}</span>}
      </div>
      {open && plan && (
        <div className="plan-body">
          <Markdown text={plan} />
        </div>
      )}
      {!resolved && (
        <div className="perm-actions">
          <button
            className="primary"
            onClick={() => props.onPerm(block.requestId, true, block.input, block.toolUseId)}
          >
            <Check size={15} />
            批准执行
          </button>
          <button
            className="danger"
            onClick={() => props.onPerm(block.requestId, false, undefined, block.toolUseId)}
          >
            <X size={15} />
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

/** Edit old_string → new_string, as two side-by-side columns with per-line
 *  gutters. Mirrors the desktop's `renderEditDiff` (grid-cols-2 + divide-x);
 *  the old column keeps its own numbering, so the pair reads as a before /
 *  after rather than one long interleaved list. */
function DiffBox(props: { input: any }) {
  const oldText = typeof props.input?.old_string === "string" ? props.input.old_string : "";
  const newText = typeof props.input?.new_string === "string" ? props.input.new_string : "";
  const oldLines: string[] = oldText ? oldText.split("\n") : [];
  const newLines: string[] = newText ? newText.split("\n") : [];
  if (oldLines.length === 0 && newLines.length === 0) return null;
  return (
    <div className="diffbox">
      <div className="diff-col old">
        {oldLines.map((line, i) => (
          <div className="diff-row del" key={`o${i}`}>
            <span className="diff-no">{i + 1}</span>
            <span className="diff-sign">−</span>
            <span className="diff-text">{line || " "}</span>
          </div>
        ))}
      </div>
      <div className="diff-col new">
        {newLines.map((line, i) => (
          <div className="diff-row add" key={`n${i}`}>
            <span className="diff-no">{i + 1}</span>
            <span className="diff-sign">+</span>
            <span className="diff-text">{line || " "}</span>
          </div>
        ))}
      </div>
      {props.input?.file_path && <div className="diff-path">{props.input.file_path}</div>}
    </div>
  );
}

/** Write shows every line as an addition. Capped so a 2000-line file does not
 *  push the conversation off the screen. */
function WriteDiff(props: { input: any }) {
  const content = typeof props.input?.content === "string" ? props.input.content : "";
  if (!content) return null;
  const lines: string[] = content.split("\n");
  const shown = lines.slice(0, 40);
  return (
    <div className="diffbox single">
      <div className="diff-col new">
        {shown.map((line, i) => (
          <div className="diff-row add" key={i}>
            <span className="diff-no">{i + 1}</span>
            <span className="diff-sign">+</span>
            <span className="diff-text">{line || " "}</span>
          </div>
        ))}
      </div>
      {lines.length > shown.length && <div className="diff-path">… 还有 {lines.length - shown.length} 行</div>}
      {props.input?.file_path && <div className="diff-path">{props.input.file_path}</div>}
    </div>
  );
}

/** The expanded body of a tool card: diffs for file edits, an IN / OUT card
 *  for everything else. The desktop renders every non-diff tool through the
 *  same `renderIOBlock`, so the phone matches it instead of dumping raw JSON. */
function ToolInputView(props: { block: Extract<Block, { t: "tool" }> }) {
  const { block } = props;
  if (block.name === "Edit" && (block.input?.old_string || block.input?.new_string)) {
    return <DiffBox input={block.input} />;
  }
  if (block.name === "MultiEdit" && Array.isArray(block.input?.edits)) {
    return (
      <>
        {block.input.edits.map((edit: any, i: number) => (
          <DiffBox key={i} input={edit} />
        ))}
      </>
    );
  }
  if (block.name === "Write" && typeof block.input?.content === "string") {
    return <WriteDiff input={block.input} />;
  }
  const isShell = block.name === "Bash" || block.name === "PowerShell" || block.name === "Shell";
  const hasInput = block.input && typeof block.input === "object"
    ? Object.keys(block.input).length > 0
    : !!block.input;
  const inText = isShell
    ? String(block.input?.command ?? block.input?.script ?? "")
    : hasInput ? safeJson(block.input) : "";
  const outText = block.result !== undefined ? truncate(block.result, 4000) : "";
  if (!inText && !outText) return null;
  return (
    <div className="iobox">
      {inText && (
        <div className="io-row">
          <span className="io-tag">IN</span>
          <pre className="io-text">{inText}</pre>
        </div>
      )}
      {outText && (
        <div className="io-row out">
          <span className={"io-tag" + (block.isError ? " err" : "")}>OUT</span>
          <pre className={"io-text" + (block.isError ? " err" : "")}>{outText}</pre>
        </div>
      )}
    </div>
  );
}

function ToolCard(props: { block: Extract<Block, { t: "tool" }> }) {
  const { block } = props;
  const [open, setOpen] = useState(false);
  const summary = toolSummary(block.name, block.input);
  // The model-written `description` is what tells a Bash/PowerShell call apart
  // from the next one. The desktop prints it next to the tool name, so the
  // phone does too instead of leaving the header at a bare "PowerShell".
  const description = typeof block.input?.description === "string"
    ? block.input.description.trim()
    : "";
  // TodoWrite is a checklist, not a tool call: dumping `{"todos":[...]}` as JSON
  // is unreadable on a phone, and the desktop gives it a dedicated rendering.
  if (block.name === "TodoWrite") return <TodoCard block={block} />;
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} className={"tool-chev" + (open ? " open" : "")} />
        <Wrench size={13} />
        <span className="tool-name">{toolLabel(block.name)}</span>
        {description && <span className="tool-desc">{description}</span>}
        {!block.done && (
          <span className="typing">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      {summary && !open && <div className="tool-summary">{summary}</div>}
      {open && (
        <div className="tool-body">
          <ToolInputView block={block} />
        </div>
      )}
    </div>
  );
}

/** TodoWrite rendered the way the desktop renders it: a progress count, the
 *  text of whatever is in flight, and a tree-style checklist. Expanded by
 *  default — the point of a todo list is to be read, not uncovered. */
function TodoCard(props: { block: Extract<Block, { t: "tool" }> }) {
  const [open, setOpen] = useState(true);
  const items: TodoItem[] = Array.isArray(props.block.input?.todos) ? props.block.input.todos : [];
  const done = items.filter((i) => i.status === "completed").length;
  const active = items.find((i) => i.status === "in_progress");
  return (
    <div className="todo">
      <div className="todo-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} className={"tool-chev" + (open ? " open" : "")} />
        <span className="todo-title">待办</span>
        <span className="todo-count">
          {done}/{items.length}
        </span>
        {active && <span className="todo-active">{active.activeForm || active.content}</span>}
      </div>
      {open && items.length > 0 && (
        <div className="todo-body">
          {items.map((item, i) => (
            <div className="todo-row" key={i}>
              <span className="todo-conn" />
              <TodoMark status={item.status} />
              <span className={"todo-text " + (item.status || "pending")}>{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TodoMark(props: { status?: string }) {
  if (props.status === "completed") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="todo-mark done">
        <rect x="0.5" y="0.5" width="11" height="11" rx="2" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" />
        <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (props.status === "in_progress") return <span className="todo-mark dot" />;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="todo-mark">
      <rect x="0.5" y="0.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** Collapsible wrapper for 3+ consecutive tool calls, mirroring the desktop's
 *  `ToolGroup`. Collapsed it is one summary line; expanded it inlines the same
 *  `ToolCard`s that would otherwise be listed one per row. */
function ToolGroupView(props: { msgs: Msg[] }) {
  const [open, setOpen] = useState(false);
  const blocks = props.msgs.map((m) => m.blocks[0] as Extract<Block, { t: "tool" }>);
  const counts = new Map<string, number>();
  for (const b of blocks) {
    const label = toolLabel(b.name);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const summary = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
  const allDone = blocks.every((b) => b.done);
  return (
    <div className="msg assistant">
      <div className="avatar-spacer" />
      <div className="msg-body">
        <div className="toolgroup">
          <div className="tool-head" onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={13} className={"tool-chev" + (open ? " open" : "")} />
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="toolgroup-icon"
            >
              <rect x="2" y="2" width="7" height="7" rx="1.5" />
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" opacity="0.5" />
            </svg>
            <span className="toolgroup-title">{blocks.length} 个工具调用</span>
            <span className="toolgroup-summary">({summary})</span>
            {allDone && !open && <Check size={12} className="toolgroup-done" />}
          </div>
          {open && (
            <div className="toolgroup-body">
              {blocks.map((b, i) => (
                <ToolCard key={props.msgs[i].id} block={b} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Thinking(props: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!props.text) return null;
  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <Sparkle size={13} />
        <span>思考</span>
        <ChevronDown size={13} className={"tool-chev" + (open ? " open" : "")} />
      </div>
      {open && <div className="thinking-body">{props.text}</div>}
    </div>
  );
}

function Markdown(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(props.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md message-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {props.text}
      </ReactMarkdown>
      {props.text.trim().length > 0 && (
        <button className="copybtn" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      )}
    </div>
  );
}

function InputBox(props: { onSend: (t: string) => void; running: boolean; onStop: () => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    props.onSend(t);
    setText("");
  };
  return (
    <>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="发送消息…"
        rows={1}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 128) + "px";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {props.running && (
        <button className="stopbtn" onClick={props.onStop} title="中断">
          <StopSquare size={15} />
        </button>
      )}
      <button
        className="sendbtn"
        onClick={send}
        disabled={!text.trim()}
        title={props.running ? "排队发送" : "发送"}
      >
        <ArrowUp size={17} />
      </button>
    </>
  );
}

// --- new session -----------------------------------------------------------

function NewSession(props: {
  client: RemoteClient;
  onCancel: () => void;
  onCreated: (
    entry: SessionEntry,
    stdinId: string,
    cliId: string | null,
    first: string,
    opts: { model: string; mode: string; providerId: string },
  ) => void;
}) {
  const [cwd, setCwd] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [providers, setProviders] = useState<{ activeId: string; list: ProviderInfo[] }>({ activeId: "", list: [] });
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"bypassPermissions" | "default" | "plan">("bypassPermissions");
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setProjects(await props.client.call<RecentProject[]>("listRecentProjects"));
      } catch {
        /* ignore */
      }
      try {
        const p = await props.client.call<any>("listProviders");
        const list: ProviderInfo[] = p?.providers || [];
        const activeId: string = p?.activeProviderId || list[0]?.id || "";
        setProviders({ activeId, list });
        setProviderId(activeId);
        applyModels(list.find((x) => x.id === activeId));
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyModels = (p?: ProviderInfo) => {
    const map = p?.modelMappings || [];
    const names = Array.from(new Set(map.map((m) => m.providerModel)));
    setModels(names);
    const preferred = map.find((m) => m.tier === "opus")?.providerModel || names[0] || "";
    setModel(preferred);
  };

  const create = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    try {
      const info = await props.client.call<any>("startSession", {
        params: {
          cwd: cwd.trim(),
          prompt: message.trim(),
          providerId: providerId || undefined,
          model: model || undefined,
          permissionMode: mode,
        },
      });
      const entry: SessionEntry = {
        id: info.cli_session_id || info.stdin_id,
        path: "",
        project: cwd.trim().split(/[\\/]/).filter(Boolean).pop() || cwd.trim(),
        projectDir: cwd.trim(),
        preview: message.trim(),
        modifiedAt: Date.now(),
      };
      props.onCreated(entry, info.stdin_id, info.cli_session_id ?? null, message.trim(), {
        model,
        mode,
        providerId,
      });
    } catch (e: any) {
      alert("新建会话失败：" + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (browsing) {
    return <DirBrowser start={cwd} onPick={(p) => { setCwd(p); setBrowsing(false); }} onCancel={() => setBrowsing(false)} client={props.client} />;
  }

  return (
    <div className="scroll">
      <div className="field">
        <label>工作目录</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="D:\path\to\project" />
      </div>
      {projects.length > 0 && (
        <>
          <div className="section-title">最近项目</div>
          <div className="row wrap" style={{ padding: "0 0.875rem 0.625rem" }}>
            {projects.slice(0, 12).map((p) => (
              <button key={p.path} className={"pill" + (cwd === p.path ? " on" : "")} onClick={() => setCwd(p.path)}>
                {p.name}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ padding: "0 0.875rem 0.75rem" }}>
        <button onClick={() => setBrowsing(true)}>
          <Folder size={15} />
          浏览目录…
        </button>
      </div>

      {providers.list.length > 0 && (
        <>
          <div className="field">
            <label>供应商</label>
            <select
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                applyModels(providers.list.find((x) => x.id === e.target.value));
              }}
            >
              {providers.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === providers.activeId ? "（当前）" : ""}
                </option>
              ))}
            </select>
          </div>
          {models.length > 0 && (
            <div className="field">
              <label>模型</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      <div className="field">
        <label>权限模式</label>
        <div className="seg">
          {(
            [
              ["bypassPermissions", "自动"],
              ["default", "询问"],
              ["plan", "计划"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={mode === v ? "on" : ""} onClick={() => setMode(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>第一条消息（可选）</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="想让它做什么？"
        />
      </div>

      <div className="actions">
        <button onClick={props.onCancel}>取消</button>
        <button className="primary" disabled={!cwd.trim() || busy} onClick={create}>
          {busy && <Loader size={15} />}
          {busy ? "启动中…" : "启动会话"}
        </button>
      </div>
    </div>
  );
}

function DirBrowser(props: { start: string; client: RemoteClient; onPick: (p: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(props.start || "");
  const [data, setData] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (p: string) => {
      try {
        const d = await props.client.call<any>("listDir", { path: p });
        setData(d);
        setPath(d.path);
        setErr(null);
      } catch (e: any) {
        setErr(String(e?.message || e));
      }
    },
    [props.client],
  );

  useEffect(() => {
    void load(props.start || "");
  }, [load, props.start]);

  return (
    <>
      <div className="dir">
        <span className="icon">
          <Folder size={16} />
        </span>
        <span className="path" title={path}>
          {path}
        </span>
      </div>
      <div className="scroll">
        {err && <div className="err">{err}</div>}
        {data?.parent && (
          <div className="dir" onClick={() => void load(data.parent!)}>
            <span className="icon">
              <CornerUpLeft size={16} />
            </span>
            <span>上一级</span>
          </div>
        )}
        {data?.dirs.map((d) => (
          <div key={d.path} className="dir" onClick={() => void load(d.path)}>
            <span className="icon">
              <Folder size={16} />
            </span>
            <span>{d.name}</span>
          </div>
        ))}
        {data && data.dirs.length === 0 && <div className="empty">此目录下没有子文件夹</div>}
      </div>
      <div className="actions">
        <button onClick={props.onCancel}>取消</button>
        <button className="primary" onClick={() => props.onPick(path)}>
          选用此目录
        </button>
      </div>
    </>
  );
}

// --- first-run / settings --------------------------------------------------

function Setup(props: {
  initial: RemoteConfig;
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  onSave: (c: RemoteConfig) => void;
  keepAlive: boolean;
  onKeepAlive: (enabled: boolean) => void;
  onCancel?: () => void;
}) {
  const { appearance, onAppearance } = props;
  const [link, setLink] = useState(props.initial.base);
  const [token, setToken] = useState(props.initial.token);
  const ok = !!link.trim() && !!token.trim();
  const dark = isDarkResolved(appearance);
  const native = isNative();

  return (
    <div className="scroll">
      <div className="section-title">连接</div>
      <div className="field">
        <label>服务器地址或完整链接</label>
        <input
          value={link}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://token.example.com/?token=…"
          onChange={(e) => {
            const v = e.target.value;
            setLink(v);
            const parsed = parseLink(v);
            if (parsed.token) setToken(parsed.token);
          }}
        />
      </div>
      <div className="field">
        <label>访问令牌</label>
        <input
          value={token}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="32 位令牌"
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="actions">
        {props.onCancel && <button onClick={props.onCancel}>取消</button>}
        <button className="primary" disabled={!ok} onClick={() => props.onSave({ base: link, token })}>
          保存并连接
        </button>
      </div>
      <div className="hint">
        把电脑上那条带 <code>?token=…</code> 的访问链接整段粘到第一栏，令牌会自动填好。
      </div>

      {native && (
        <>
          <div className="section-title">后台通知</div>
          <div className="field">
            <label>有需要我处理的问题时提醒</label>
            <div className="seg">
              <button
                className={props.keepAlive ? "on" : ""}
                onClick={() => props.onKeepAlive(true)}
              >
                开启
              </button>
              <button
                className={props.keepAlive ? "" : "on"}
                onClick={() => props.onKeepAlive(false)}
              >
                关闭
              </button>
            </div>
          </div>
          <div className="hint">
            开启后由后台服务独立连到电脑端，划掉 App 也能收到通知。若系统清理后台，
            请在手机设置里给 TOKENICODE 允许「后台运行」并把电池策略设为「不限制」。
          </div>
        </>
      )}

      <div className="section-title">外观</div>
      <div className="field">
        <label>强调色</label>
        <div className="swatches">
          {COLOR_THEMES.map((c) => (
            <button
              key={c.id}
              className={"swatch" + (appearance.colorTheme === c.id ? " on" : "")}
              title={c.label}
              aria-label={c.label}
              onClick={() => onAppearance({ ...appearance, colorTheme: c.id })}
            >
              <i style={{ background: dark ? c.dark : c.light }} />
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>明暗</label>
        <div className="seg">
          {THEME_MODES.map((m) => (
            <button
              key={m.id}
              className={appearance.theme === m.id ? "on" : ""}
              onClick={() => onAppearance({ ...appearance, theme: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>字号 · {appearance.fontSize}px</label>
        <input
          className="slider"
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          value={appearance.fontSize}
          onChange={(e) => onAppearance({ ...appearance, fontSize: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function blocksText(blocks: Block[]): string {
  return blocks.map((b) => (b.t === "text" ? b.text : "")).join("");
}

function safeJson(v: any): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v ?? {}, null, 2);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…（已截断 ${s.length - n} 字符）` : s;
}

function baseName(p: string): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function relTime(ms: number): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString();
}

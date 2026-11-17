/**
 * Display model for a single Claude session.
 *
 * The live WebSocket payloads are Claude Code's own stream-json messages
 * (identical to what the desktop WebView receives). This module folds them
 * into a flat list of chat messages the phone can render, matching the
 * desktop's semantics: text/thinking stream token-by-token, tool calls show
 * as cards that fill in their result, permission requests become approval
 * cards.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** One row of a `TodoWrite` list, as the CLI sends it. */
export interface TodoItem {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type Block =
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "image"; src: string; alt?: string }
  | {
      t: "tool";
      id: string;
      name: string;
      input: any;
      raw?: string;
      result?: string;
      isError?: boolean;
      done?: boolean;
    }
  | {
      t: "perm";
      requestId: string;
      toolName: string;
      input: any;
      toolUseId?: string;
      description?: string;
      resolved?: "allow" | "deny";
      /** Chosen labels, for the answered-state readout. */
      answer?: string;
    };

export interface Msg {
  id: string;
  role: "user" | "assistant" | "system";
  blocks: Block[];
  ts: number;
  pending?: boolean;
  /** Typed while a turn was running; sent as soon as the turn ends. */
  queued?: boolean;
  /** Set on assistant text msgs created from stream deltas, used for dedupe. */
  streamed?: boolean;
}

export interface ResultInfo {
  costUsd?: number;
  durationMs?: number;
  isError?: boolean;
  text?: string;
}

/** What a transcript yields besides its messages. */
export interface ParsedHistory {
  messages: Msg[];
  /** Window occupancy from the last assistant turn; 0 when none was recorded. */
  contextTokens: number;
  /** Model id reported by the CLI, empty when the transcript never names one. */
  model: string;
}

const TOOL_LABEL: Record<string, string> = {
  Bash: "运行命令",
  Read: "读取文件",
  Edit: "编辑文件",
  Write: "写入文件",
  Glob: "查找文件",
  Grep: "搜索内容",
  WebFetch: "抓取网页",
  WebSearch: "联网搜索",
  Task: "子任务",
  TodoWrite: "更新待办",
  NotebookEdit: "编辑 Notebook",
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] || name;
}

/** One-line summary of a tool call's input, for the card header. */
export function toolSummary(_name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const first = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt;
  if (typeof first === "string") {
    const one = first.replace(/\s+/g, " ").trim();
    return one.length > 160 ? one.slice(0, 160) + "…" : one;
  }
  return "";
}

let seq = 0;
function nid(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

/**
 * Tokens occupying the context window for one API call: fresh input plus both
 * cache buckets. Same formula as the desktop's `contextTokensFromUsage` —
 * `result.usage` is a whole-turn total that a tool loop multiplies, so only the
 * per-call number belongs next to a context window.
 */
export function usageContextTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const n = (v: any) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

/** Turn an Anthropic image block into something an <img> can take. */
export function imageSrc(block: any): string | null {
  const src = block?.source;
  if (src && typeof src === "object") {
    if (src.type === "base64" && typeof src.data === "string") {
      return `data:${src.media_type || "image/png"};base64,${src.data}`;
    }
    if (src.type === "url" && typeof src.url === "string") return src.url;
  }
  if (typeof block?.url === "string") return block.url;
  return null;
}

/** Strip system-injected content the desktop also hides. */
function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<") ||
    t.includes("<system-reminder>") ||
    t.startsWith("This session is being continued") ||
    t.startsWith("Caveat:") ||
    t.startsWith("Human:")
  );
}

export class SessionModel {
  messages: Msg[] = [];
  cliSessionId: string | null = null;
  stdinId: string | null = null;
  status: "idle" | "streaming" | "ended" = "idle";
  result: ResultInfo | null = null;
  touched = 0;
  /** Params needed to resume this session when it is idle. */
  resumeCwd = "";
  resumeProviderId = "";
  resumeModel = "";
  /** Permission mode to resume with; the phone no longer assumes bypass. */
  resumePermissionMode = "bypassPermissions";
  /** Model the CLI reports for the current turn (e.g. `deepseek-flash`). */
  model = "";
  /** Window occupancy of the latest API call, cache buckets included. */
  contextTokens = 0;
  /** Context window as reported by `result.modelUsage`; 0 until the first result. */
  contextWindow = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** Cumulative cost for the session, as the CLI reports it. */
  costUsd = 0;
  turnStartedAt = 0;
  /** Messages typed while a turn was running; drained on the next result. */
  queue: string[] = [];

  private liveTextId: string | null = null;
  private liveThinkId: string | null = null;
  private curToolId: string | null = null;
  private toolByUseId = new Map<string, Extract<Block, { t: "tool" }>>();

  reset() {
    this.messages = [];
    this.cliSessionId = null;
    this.status = "idle";
    this.result = null;
    this.liveTextId = null;
    this.liveThinkId = null;
    this.curToolId = null;
    this.toolByUseId.clear();
    this.contextTokens = 0;
    this.contextWindow = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
    this.turnStartedAt = 0;
    this.queue = [];
  }

  private push(role: Msg["role"], blocks: Block[], extra: Partial<Msg> = {}): Msg {
    const m: Msg = { id: nid(), role, blocks, ts: Date.now(), ...extra };
    this.messages.push(m);
    this.touched++;
    return m;
  }

  private last(): Msg | undefined {
    return this.messages[this.messages.length - 1];
  }

  // --- live stream helpers -------------------------------------------------

  private ensureText(): Msg {
    const last = this.last();
    if (this.liveTextId && last && last.id === this.liveTextId) return last;
    const m = this.push("assistant", [{ t: "text", text: "" }], { streamed: true });
    this.liveTextId = m.id;
    return m;
  }

  private appendText(text: string) {
    const m = this.ensureText();
    (m.blocks[0] as Extract<Block, { t: "text" }>).text += text;
    this.touched++;
  }

  private ensureThinking(): Msg {
    const last = this.last();
    if (this.liveThinkId && last && last.id === this.liveThinkId) return last;
    const m = this.push("assistant", [{ t: "thinking", text: "" }], { streamed: true });
    this.liveThinkId = m.id;
    return m;
  }

  private appendThinking(text: string) {
    const m = this.ensureThinking();
    (m.blocks[0] as Extract<Block, { t: "thinking" }>).text += text;
    this.touched++;
  }

  private startTool(id: string, name: string) {
    const existing = this.toolByUseId.get(id);
    if (existing) {
      this.curToolId = id;
      return existing;
    }
    const block: Extract<Block, { t: "tool" }> = { t: "tool", id, name, input: {}, raw: "" };
    this.toolByUseId.set(id, block);
    this.push("assistant", [block]);
    this.curToolId = id;
    return block;
  }

  private appendToolJson(partial: string) {
    if (!this.curToolId) return;
    const b = this.toolByUseId.get(this.curToolId);
    if (!b) return;
    b.raw = (b.raw || "") + partial;
    try {
      b.input = JSON.parse(b.raw);
    } catch {
      /* still streaming */
    }
    this.touched++;
  }

  private attachToolResult(toolUseId: string, text: string, isError: boolean) {
    const b = this.toolByUseId.get(toolUseId);
    if (!b) return;
    b.result = text;
    b.isError = isError;
    b.done = true;
    this.touched++;
  }

  // --- event intake --------------------------------------------------------

  /** Apply one mirrored event. Returns true when the view should re-render. */
  applyEvent(channel: string, data: any): boolean {
    if (!data || typeof data !== "object") return false;
    const before = this.touched;
    const type = data.type;

    if (type === "system") {
      if (data.subtype === "init") {
        if (data.session_id) this.cliSessionId = data.session_id;
        if (data.cwd && this.messages.length === 0) {
          this.push("system", [{ t: "text", text: `会话就绪 · ${data.cwd}` }]);
        }
      } else if (data.subtype === "error") {
        this.push("system", [{ t: "text", text: `错误：${data.error || data.message || "unknown"}` }]);
      }
      return this.touched !== before;
    }

    if (type === "stream_event") {
      const ev = data.event || {};
      const et = ev.type;
      if (et === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "text") {
          this.liveTextId = null; // force a fresh block
          this.ensureText();
        } else if (cb.type === "thinking") {
          this.liveThinkId = null;
          this.ensureThinking();
        } else if (cb.type === "tool_use") {
          this.startTool(cb.id || nid(), cb.name || "tool");
        }
      } else if (et === "content_block_delta") {
        const d = ev.delta || {};
        if (d.type === "text_delta" && typeof d.text === "string") this.appendText(d.text);
        else if (d.type === "thinking_delta" && typeof d.thinking === "string") this.appendThinking(d.thinking);
        else if (d.type === "input_json_delta" && typeof d.partial_json === "string") this.appendToolJson(d.partial_json);
      } else if (et === "content_block_stop") {
        this.liveTextId = null;
        this.liveThinkId = null;
        this.curToolId = null;
      } else if (et === "message_start") {
        this.liveTextId = null;
        this.liveThinkId = null;
        const started = ev.message || {};
        const usage = started.usage;
        const ctx = usageContextTokens(usage);
        if (ctx > 0) this.contextTokens = ctx;
        if (typeof usage?.input_tokens === "number") this.inputTokens += usage.input_tokens;
        if (typeof usage?.output_tokens === "number") this.outputTokens = usage.output_tokens;
        if (typeof started.model === "string" && started.model) this.model = started.model;
        this.turnStartedAt = Date.now();
      } else if (et === "message_delta") {
        // `output_tokens` here is the running total for this message, not a delta.
        const u = ev.usage || {};
        if (typeof u.output_tokens === "number") this.outputTokens = u.output_tokens;
        if (typeof u.input_tokens === "number") this.inputTokens = u.input_tokens;
      } else if (et === "message_stop") {
        this.liveTextId = null;
        this.liveThinkId = null;
        this.curToolId = null;
      }
      if (this.status !== "ended") this.status = "streaming";
      return this.touched !== before;
    }

    if (type === "assistant") {
      const um = data.message || {};
      if (typeof um.model === "string" && um.model) this.model = um.model;
      const ctx = usageContextTokens(um.usage);
      if (ctx > 0) this.contextTokens = ctx;
      const content = um.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            if (!block.text || isSystemText(block.text)) continue;
            // Reuse the streamed msg if it holds exactly this text.
            const streamed = this.messages.find(
              (m) => m.streamed && m.role === "assistant" && m.blocks[0]?.t === "text" && !(m as any).finalized,
            );
            if (streamed && (streamed.blocks[0] as any).text.trim() === block.text.trim()) {
              (streamed.blocks[0] as any).text = block.text;
              (streamed as any).finalized = true;
              this.touched++;
            } else if (streamed) {
              (streamed.blocks[0] as any).text = block.text;
              (streamed as any).finalized = true;
              this.touched++;
            } else {
              this.push("assistant", [{ t: "text", text: block.text }]);
            }
          } else if (block.type === "thinking") {
            const streamed = this.messages.find(
              (m) => m.streamed && m.role === "assistant" && m.blocks[0]?.t === "thinking" && !(m as any).finalized,
            );
            if (streamed) {
              (streamed.blocks[0] as any).text = block.thinking || "";
              (streamed as any).finalized = true;
              this.touched++;
            } else if (block.thinking) {
              this.push("assistant", [{ t: "thinking", text: block.thinking }]);
            }
          } else if (block.type === "tool_use") {
            const b = this.startTool(block.id, block.name);
            b.input = block.input ?? {};
            b.raw = undefined;
            this.curToolId = null;
            this.touched++;
          } else if (block.type === "image") {
            const src = imageSrc(block);
            if (src) {
              this.push("assistant", [{ t: "image", src }]);
              this.touched++;
            }
          }
        }
      }
      if (this.status !== "ended") this.status = "streaming";
      return this.touched !== before;
    }

    if (type === "user") {
      const content = data.message?.content;
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      let anyToolResult = false;
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          anyToolResult = true;
          const text = normalizeToolResult(b.content ?? b.output);
          this.attachToolResult(b.tool_use_id, text, !!b.is_error);
        } else if (b?.type === "image") {
          const src = imageSrc(b);
          if (src) {
            this.push("user", [{ t: "image", src }]);
            this.touched++;
          }
        }
      }
      if (anyToolResult) return this.touched !== before;

      // Replayed user message (--replay-user-messages): confirm optimistic send.
      const texts = blocks
        .filter((b: any) => b?.type === "text" && b.text && !isSystemText(b.text))
        .map((b: any) => b.text as string);
      if (texts.length) {
        const joined = texts.join("");
        const pendingIdx = this.messages.findIndex((m) => m.pending && m.role === "user");
        if (pendingIdx >= 0) {
          const pm = this.messages[pendingIdx];
          (pm.blocks[0] as any).text = joined;
          pm.pending = false;
          this.touched++;
        } else {
          const dup = this.messages.some(
            (m) => m.role === "user" && m.blocks[0]?.t === "text" && (m.blocks[0] as any).text.trim() === joined.trim(),
          );
          if (!dup) this.push("user", [{ t: "text", text: joined }]);
        }
      }
      return this.touched !== before;
    }

    if (type === "result") {
      const usage = data.usage || {};
      // `result.usage` is the whole-turn total; it is only used for the running
      // token counters, never as the context-window numerator.
      if (typeof usage.input_tokens === "number") this.inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") this.outputTokens = usage.output_tokens;
      const mu = data.modelUsage;
      if (mu && typeof mu === "object") {
        for (const key of Object.keys(mu)) {
          const cw = mu[key]?.contextWindow;
          if (typeof cw === "number" && cw > 0) {
            this.contextWindow = cw;
            break;
          }
        }
      }
      if (typeof data.total_cost_usd === "number") this.costUsd = data.total_cost_usd;
      this.result = {
        costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
        durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
        isError: !!data.is_error,
        text: typeof data.result === "string" ? data.result : undefined,
      };
      if (data.session_id && !this.cliSessionId) this.cliSessionId = data.session_id;
      this.status = "idle";
      this.liveTextId = null;
      this.liveThinkId = null;
      this.curToolId = null;
      this.touched++;
      return true;
    }

    if (type === "process_exit") {
      this.status = "ended";
      this.push("system", [{ t: "text", text: "进程已退出" }]);
      return true;
    }

    if (type === "tokenicode_permission_request") {
      this.push("assistant", [
        {
          t: "perm",
          requestId: data.request_id,
          toolName: data.tool_name,
          input: data.input,
          toolUseId: data.tool_use_id,
          description: data.description,
        },
      ]);
      return true;
    }

    return this.touched !== before;
  }

  /** Record the user's own send optimistically (until the replay echo lands). */
  addUserMessage(text: string) {
    this.push("user", [{ t: "text", text }], { pending: true });
  }

  /** Mark a permission card as answered. */
  resolvePermission(requestId: string, allow: boolean, answer?: string) {
    for (const m of this.messages) {
      for (const b of m.blocks) {
        if (b.t === "perm" && b.requestId === requestId) {
          b.resolved = allow ? "allow" : "deny";
          if (answer) b.answer = answer;
          this.touched++;
        }
      }
    }
  }
}

function normalizeToolResult(payload: any): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.map((i: any) => i?.text || i?.content || "").join("");
  }
  if (payload && typeof payload === "object") {
    if (typeof payload.stdout === "string") return payload.stdout;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.content === "string") return payload.content;
    if (Array.isArray(payload.content)) return payload.content.map((i: any) => i?.text || "").join("");
  }
  return "";
}

/** Parse a raw jsonl transcript (from loadSession) into display messages.
 *  The last per-call usage and model name are returned too, so a session opened
 *  from the list shows its real Ctx occupancy instead of starting at zero. */
export function parseHistory(rawMessages: any[]): ParsedHistory {
  const out: Msg[] = [];
  const toolUseIdToBlock = new Map<string, Extract<Block, { t: "tool" }>>();
  let contextTokens = 0;
  let model = "";

  const bind = (toolUseId: string | undefined, text: string) => {
    if (!toolUseId) return;
    const b = toolUseIdToBlock.get(toolUseId);
    if (b) {
      b.result = text;
      b.done = true;
      if (/^error|failed|exception/i.test(text)) b.isError = true;
    }
  };

  for (const msg of rawMessages) {
    if (!msg || msg.isMeta) continue;

    // Transcripts carry results as a `user` message whose content is a
    // `tool_result` block, so the block shape has to be checked too — keying
    // only off the message type left every historical tool without its output
    // (and without `done`, so the group summary never showed its tick).
    const resultBlocks = Array.isArray(msg.message?.content)
      ? msg.message.content
      : Array.isArray(msg.content)
        ? msg.content
        : [];

    const hasToolResult =
      msg.type === "tool_result" ||
      Object.prototype.hasOwnProperty.call(msg, "tool_use_result") ||
      Object.prototype.hasOwnProperty.call(msg, "tool_result") ||
      resultBlocks.some((b: any) => b?.type === "tool_result");

    if (hasToolResult) {
      const tl =
        msg.tool_use_result ?? msg.tool_result ?? msg.toolUseResult ?? msg.toolResult;
      const tlText = normalizeToolResult(tl);
      for (const b of resultBlocks) {
        if (b?.tool_use_id) bind(b.tool_use_id, tlText || normalizeToolResult(b.content ?? b.output));
      }
      bind(msg.tool_use_id ?? msg.toolUseId, tlText);
      continue;
    }

    if (msg.type === "human" || msg.type === "user" || msg.role === "user") {
      const content = msg.message?.content;
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      const texts = blocks
        .filter((b: any) => (typeof b === "string" ? true : b?.type === "text" && b.text))
        .map((b: any) => (typeof b === "string" ? b : b.text))
        .filter((t: string) => t && !isSystemText(t));
      if (texts.length) out.push({ id: msg.uuid || nid(), role: "user", blocks: [{ t: "text", text: texts.join("") }], ts: tsOf(msg) });
      for (const b of blocks) {
        if (typeof b === "object" && b?.type === "image") {
          const src = imageSrc(b);
          if (src) out.push({ id: nid(), role: "user", blocks: [{ t: "image", src }], ts: tsOf(msg) });
        }
      }
      continue;
    }

    if (msg.type === "assistant") {
      const blocks = msg.message?.content;
      const ctx = usageContextTokens(msg.message?.usage ?? msg.usage);
      if (ctx > 0) contextTokens = ctx;
      if (typeof msg.message?.model === "string" && msg.message.model) model = msg.message.model;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === "text") {
          if (isSystemText(block.text || "")) continue;
          out.push({ id: msg.uuid || nid(), role: "assistant", blocks: [{ t: "text", text: block.text }], ts: tsOf(msg) });
        } else if (block.type === "thinking") {
          if (block.thinking) out.push({ id: nid(), role: "assistant", blocks: [{ t: "thinking", text: block.thinking }], ts: tsOf(msg) });
        } else if (block.type === "tool_use") {
          const tb: Extract<Block, { t: "tool" }> = { t: "tool", id: block.id || nid(), name: block.name, input: block.input ?? {} };
          toolUseIdToBlock.set(block.id, tb);
          out.push({ id: msg.uuid || nid(), role: "assistant", blocks: [tb], ts: tsOf(msg) });
        } else if (block.type === "image") {
          const src = imageSrc(block);
          if (src) out.push({ id: nid(), role: "assistant", blocks: [{ t: "image", src }], ts: tsOf(msg) });
        }
      }
    }
  }
  return { messages: out, contextTokens, model };
}

function tsOf(msg: any): number {
  if (typeof msg.timestamp === "string") {
    const t = Date.parse(msg.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof msg.timestamp === "number") return msg.timestamp;
  return Date.now();
}

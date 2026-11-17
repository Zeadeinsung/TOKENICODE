/**
 * WebSocket client for the TOKENICODE remote hub.
 *
 * Wire protocol (JSON text frames):
 *   server → client event:  { "ev": "<channel>", "data": <payload> }
 *   server → client reply:  { "ev": "rpc:result", "id": N, "ok": true, "data": ... }
 *                                                  or { "ok": false, "error": "..." }
 *   client → server op:     { "op": "<name>", "id": N, ...params }
 *
 * The event channels are the exact same names the desktop WebView listens on
 * (`claude:stream:<stdinId>`, `sessions:changed`, …), so a payload received
 * here is byte-for-byte what the desktop sees.
 */

export type ConnStatus = "connecting" | "open" | "closed";

export interface RemoteEvent {
  ev: string;
  data: any;
}

type EventHandler = (ev: RemoteEvent) => void;
type StatusHandler = (s: ConnStatus) => void;

/** The path to the hub runs through a Cloudflare tunnel, so a round trip is
 *  seconds, not milliseconds. Everything here is sized for that: the heartbeat
 *  has to be frequent enough to keep the tunnel from idling the socket out, and
 *  loose enough that a slow reply is not mistaken for a dead link. */
const HEARTBEAT_MS = 20_000;
const DEAD_AFTER_MS = 55_000;
const RPC_TIMEOUT_MS = 45_000;
/** How long a call will wait for a reconnect before giving up. */
const RECONNECT_WAIT_MS = 30_000;

export class RemoteClient {
  private ws: WebSocket | null = null;
  private base: string;
  private token: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private eventHandlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private retry = 0;
  private closedByUser = false;
  private timer: number | null = null;
  private heartbeat: number | null = null;
  private lastSeen = 0;
  status: ConnStatus = "connecting";

  constructor(base: string, token: string) {
    this.base = base || location.origin;
    this.token = token;
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private setStatus(s: ConnStatus) {
    this.status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  private open() {
    this.setStatus("connecting");
    let origin: URL;
    try {
      origin = new URL(this.base);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const proto = origin.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${origin.host}/ws?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      this.startHeartbeat();
    };
    ws.onmessage = (e) => {
      this.lastSeen = Date.now();
      let v: any;
      try {
        v = JSON.parse(e.data);
      } catch {
        return;
      }
      if (v.ev === "rpc:result") {
        const p = this.pending.get(v.id);
        if (p) {
          this.pending.delete(v.id);
          if (v.ok) p.resolve(v.data);
          else p.reject(new Error(v.error || "rpc failed"));
        }
        return;
      }
      const ev: RemoteEvent = { ev: v.ev, data: v.data };
      this.eventHandlers.forEach((h) => h(ev));
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.setStatus("closed");
      this.failAllPending("connection closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  /** Polls the link so the tunnel sees traffic, and drops a socket that has
   *  gone quiet — a backgrounded WebView usually leaves a half-open connection
   *  that never fires `onclose`, which is what strands the UI on "connecting". */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastSeen = Date.now();
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
        this.stopHeartbeat();
        try {
          this.ws?.close();
        } catch {
          /* noop */
        }
        return;
      }
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ op: "ping", id: this.nextId++ }));
      } catch {
        /* the close handler will pick it up */
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect() {
    if (this.timer !== null) return;
    const delay = Math.min(800 * 2 ** this.retry, 8000);
    this.retry += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private failAllPending(reason: string) {
    this.pending.forEach((p) => p.reject(new Error(reason)));
    this.pending.clear();
  }

  /** Resolve once the socket is usable, or reject after `ms`. Lets a call made
   *  while the link is down ride out the reconnect instead of failing at once. */
  private waitForOpen(ms: number): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (this.closedByUser) {
        reject(new Error("not connected"));
        return;
      }
      const started = Date.now();
      const t = window.setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(t);
          reject(new Error("not connected"));
        }
      }, 250);
    });
  }

  /** Send an op and await its RPC result. */
  async call<T = any>(op: string, params: Record<string, any> = {}): Promise<T> {
    await this.waitForOpen(RECONNECT_WAIT_MS);
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ op, id, ...params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      window.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${op}`));
      }, RPC_TIMEOUT_MS);
    });
  }

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  onStatus(h: StatusHandler): () => void {
    this.statusHandlers.add(h);
    h(this.status);
    return () => this.statusHandlers.delete(h);
  }

  close() {
    this.closedByUser = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
  }
}

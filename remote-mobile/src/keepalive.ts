/**
 * Bridge to the Android foreground service that holds its own WebSocket.
 *
 * The WebView's connection dies with the Activity when the app is swiped away,
 * so background notifications need a connection that does not. On the web (or
 * any non-Android target) every call here is a no-op.
 */

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

interface KeepAlivePlugin {
  start(options: { base: string; token: string }): Promise<void>;
  stop(): Promise<void>;
  setContext(options: { stdinId: string | null; foreground: boolean }): Promise<void>;
  addListener(
    eventName: "openSession",
    cb: (data: { session: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const KeepAlive = registerPlugin<KeepAlivePlugin>("KeepAlive");

const K_ENABLED = "tokenicode.keepalive";

export function isNative(): boolean {
  const cap = (window as any).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

export function isEnabled(): boolean {
  return localStorage.getItem(K_ENABLED) === "1";
}

/** Turns the service on or off and remembers the choice. Resolves to the state
 *  it ended up in, which stays `false` when the platform cannot honour it. */
export async function setEnabled(enabled: boolean, cfg: { base: string; token: string }): Promise<boolean> {
  if (!isNative()) return false;
  try {
    if (enabled) {
      if (!cfg.base || !cfg.token) return false;
      await KeepAlive.start(cfg);
    } else {
      await KeepAlive.stop();
    }
    localStorage.setItem(K_ENABLED, enabled ? "1" : "0");
    return enabled;
  } catch {
    return false;
  }
}

/** Re-arm the service after the connection settings change. */
export async function restart(cfg: { base: string; token: string }): Promise<void> {
  if (!isNative() || !isEnabled()) return;
  try {
    await KeepAlive.start(cfg);
  } catch {
    /* the service keeps running with the previous settings */
  }
}

export async function stop(): Promise<void> {
  if (!isNative()) return;
  try {
    await KeepAlive.stop();
  } catch {
    /* ignore */
  }
}

/** Tells the service which session is on screen, so a completion the user is
 *  already watching does not also raise a notification. */
export async function reportContext(stdinId: string | null, foreground: boolean): Promise<void> {
  if (!isNative()) return;
  try {
    await KeepAlive.setContext({ stdinId, foreground });
  } catch {
    /* ignore */
  }
}

/** Fires when the app is opened by tapping a task notification, carrying that
 *  session's id. The native side retains the event until this listener attaches,
 *  so a cold start from a notification is delivered too. */
export async function onOpenSession(cb: (sessionId: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const handle = await KeepAlive.addListener("openSession", (data) => {
      const id = typeof data?.session === "string" ? data.session : "";
      if (id) cb(id);
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}

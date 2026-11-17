/**
 * Where the remote hub lives, and how to reach it.
 *
 * The same bundle is used two ways: served by the tokenicode server itself
 * (a browser, where same-origin is correct) and packaged as the Android app
 * (where there is no server origin, so the address must be configured).
 */

export interface RemoteConfig {
  base: string;
  token: string;
}

const K_BASE = "tokenicode.base";
const K_TOKEN = "tokenicode.token";

/**
 * 打包成 App 后没有页面来源，首次安装只能自己去设置页填地址。
 *
 * 这里刻意留空：这个 APK 会被分发给不同的人，预填某台服务器等于把
 * 所有人的请求都先打到那台机器上。浏览器访问不受影响，
 * `loadConfig` 用 `location.origin` 走同源。
 */
export const DEFAULT_BASE = "";

/** True inside the Capacitor shell, false in a plain browser. */
export function inShell(): boolean {
  const cap = (window as any).Capacitor;
  if (cap && typeof cap.isNativePlatform === "function") return cap.isNativePlatform();
  return location.protocol === "capacitor:" || (location.hostname === "localhost" && !location.port);
}

export function normalizeBase(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

/** Accepts either a bare server address or a full `…/?token=…` link. */
export function parseLink(raw: string): { base: string; token?: string } {
  const s = raw.trim();
  if (!s) return { base: "" };
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    const token = u.searchParams.get("token") || undefined;
    return { base: `${u.protocol}//${u.host}`, token };
  } catch {
    return { base: normalizeBase(s) };
  }
}

export function loadConfig(): RemoteConfig {
  const url = new URL(location.href);
  const qToken = url.searchParams.get("token");
  const qBase = url.searchParams.get("base");
  if (qToken) localStorage.setItem(K_TOKEN, qToken);
  if (qBase) localStorage.setItem(K_BASE, qBase);

  const stored = localStorage.getItem(K_BASE);
  // Served by the server itself → same-origin. Packaged app → the default host.
  const base = stored || (inShell() ? DEFAULT_BASE : location.origin);
  return { base: normalizeBase(base), token: localStorage.getItem(K_TOKEN) || "" };
}

export function saveConfig(cfg: RemoteConfig): RemoteConfig {
  const next = { base: normalizeBase(cfg.base), token: cfg.token.trim() };
  localStorage.setItem(K_BASE, next.base);
  localStorage.setItem(K_TOKEN, next.token);
  return next;
}

export function clearConfig(): void {
  localStorage.removeItem(K_BASE);
  localStorage.removeItem(K_TOKEN);
}

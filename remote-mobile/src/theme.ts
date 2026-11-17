/**
 * Appearance settings — the mobile counterpart of the desktop's
 * settingsStore theme slice (theme / colorTheme / fontSize).
 *
 * Values are applied to <html> as classes + a root font-size, exactly the way
 * the desktop app does it, so every rem-based size in styles.css scales with
 * the font-size setting.
 */

import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ColorTheme = "black" | "blue" | "purple" | "green";

export interface Appearance {
  theme: Theme;
  colorTheme: ColorTheme;
  /** Root font size in px. Everything else is rem, so this zooms the whole UI. */
  fontSize: number;
}

/** Desktop allows 10–36 at an 18px default; a phone wants a tighter band. */
export const FONT_MIN = 14;
export const FONT_MAX = 22;
export const FONT_DEFAULT = 17;

export const DEFAULTS: Appearance = {
  theme: "system",
  colorTheme: "black",
  fontSize: FONT_DEFAULT,
};

const KEY = "tokenicode.mobile.theme";

/** Swatch hexes mirror the desktop's GeneralTab previews. */
export const COLOR_THEMES: { id: ColorTheme; label: string; light: string; dark: string }[] = [
  { id: "black", label: "黑色", light: "#333333", dark: "#D0D0D0" },
  { id: "blue", label: "蓝色", light: "#4E80F7", dark: "#6B9AFF" },
  { id: "purple", label: "紫色", light: "#9169BF", dark: "#A684CC" },
  { id: "green", label: "绿色", light: "#57A64B", dark: "#6DBF62" },
];

export const THEME_MODES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];

const ACCENT_CLASSES = ["theme-blue", "theme-purple", "theme-green"];

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: p.theme === "light" || p.theme === "dark" || p.theme === "system" ? p.theme : DEFAULTS.theme,
      colorTheme: COLOR_THEMES.some((c) => c.id === p.colorTheme)
        ? (p.colorTheme as ColorTheme)
        : DEFAULTS.colorTheme,
      fontSize:
        typeof p.fontSize === "number"
          ? Math.max(FONT_MIN, Math.min(FONT_MAX, p.fontSize))
          : DEFAULTS.fontSize,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage disabled — appearance just won't persist */
  }
}

function prefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function isDarkResolved(a: Appearance): boolean {
  return a.theme === "dark" || (a.theme === "system" && prefersDark());
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  const dark = isDarkResolved(a);

  root.classList.toggle("dark", dark);
  root.classList.remove(...ACCENT_CLASSES);
  if (a.colorTheme !== "black") root.classList.add("theme-" + a.colorTheme);

  root.style.fontSize = a.fontSize + "px";

  // Keep the phone's status bar in step with the top bar it sits above.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  // "Follow system" has to keep following after the OS flips.
  useEffect(() => {
    if (appearance.theme !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(appearance);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance]);

  return [appearance, setAppearance] as const;
}

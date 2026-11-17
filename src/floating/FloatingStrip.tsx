import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FloatState, FloatTask } from "./types";

const EMPTY: FloatState = { tasks: [], dark: false, colorTheme: "black", locale: "zh" };

/**
 * Layout preview for `npm run dev` opened in a plain browser (no Tauri IPC).
 * Vite replaces import.meta.env.DEV with false in production, so this never
 * ships. It exists so the panel can be checked without launching the app.
 */
const DEV_PREVIEW: FloatState | null =
  import.meta.env.DEV && typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
    ? {
        dark: false,
        colorTheme: "black",
        locale: "zh",
        tasks: [
          {
            id: "preview-1",
            title: "tokenicode",
            prompt: "做一个新版本",
            action: "编辑文件：src/floating/FloatingStrip.tsx",
            phase: "running",
            alertAt: null,
            alertKind: null,
            todos: [
              { content: "梳理活动状态与浮窗数据链路", status: "completed" },
              { content: "给活动状态补充中文动作描述", status: "completed" },
              { content: "浮窗常驻显示待办进度", status: "in_progress", activeForm: "正在实现悬停展开面板" },
              { content: "构建 0.12.0 并验证", status: "pending" },
            ],
            todoDone: 2,
            todoTotal: 4,
          },
          {
            id: "preview-2",
            title: "AgriCore",
            prompt: "修复登录接口",
            action: "运行命令：npm run test -- auth",
            phase: "awaiting",
            alertAt: Date.now(),
            alertKind: "awaiting",
            todos: [
              { content: "复现 401", status: "completed" },
              { content: "检查 token 刷新逻辑", status: "in_progress", activeForm: "正在排查刷新逻辑" },
              { content: "补回归测试", status: "pending" },
            ],
            todoDone: 1,
            todoTotal: 3,
          },
          {
            id: "preview-3",
            title: "CogniFlow",
            prompt: "跑一遍构建",
            action: "已结束",
            phase: "completed",
            alertAt: Date.now(),
            alertKind: "completed",
            todos: [
              { content: "跑构建", status: "completed" },
              { content: "上传产物", status: "completed" },
            ],
            todoDone: 2,
            todoTotal: 2,
          },
        ],
      }
    : null;

const LABELS = {
  zh: {
    todos: "待办",
    noTodos: "这个任务还没有待办清单",
    inProgress: "进行中",
    empty: "没有正在运行的任务",
    open: "打开会话",
    hint: "单击查看进度，双击打开会话",
  },
  en: {
    todos: "Todos",
    noTodos: "No todo list for this task yet",
    inProgress: "In progress",
    empty: "No running tasks",
    open: "Open session",
    hint: "Click for progress, double-click to open the session",
  },
} as const;

/** Window width while the todo panel is closed (must match Rust's
 *  FLOAT_RAIL_WIDTH). */
const RAIL_WIDTH = 52;
/** Panel width; the open window is RAIL_WIDTH + PANEL_WIDTH + GAP + margin. */
const PANEL_WIDTH = 312;
const WINDOW_GAP = 8;
/** Breathing room on the left so the panel's shadow is not clipped. */
const PANEL_LEFT_MARGIN = 10;
const OPEN_WIDTH = RAIL_WIDTH + WINDOW_GAP + PANEL_WIDTH + PANEL_LEFT_MARGIN;
const RAIL_PAD = 10;
/** Height of the vertical glass lozenge around each dot (width is set in CSS). */
const DOT_HEIGHT = 34;
const DOT_GAP = 8;
const PANEL_PAD = 12;
const MAX_WINDOW_HEIGHT = 640;
/** Single click waits this long so a double click can cancel it. */
const DOUBLE_CLICK_MS = 240;

function railHeight(count: number): number {
  if (count === 0) return RAIL_WIDTH;
  return RAIL_PAD * 2 + count * DOT_HEIGHT + Math.max(0, count - 1) * DOT_GAP;
}

/**
 * The always-on-top rail of running tasks pinned to the right edge of the
 * screen.
 *
 * It owns no application state: the main window derives a compact snapshot and
 * pushes it on `float:state`. The only local state is which alert the user has
 * already acknowledged, tracked by `(taskId, alertAt)` so that a second alert on
 * the same task lights its dot up again, plus which dot's todo panel is open.
 *
 * Interaction: one dot per session, coloured by state. A single click opens the
 * todo panel to its left, a second click closes it, and a double click jumps
 * straight to that session in the main window.
 */
export function FloatingStrip() {
  const [state, setState] = useState<FloatState>(EMPTY);
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const clickTimer = useRef<number | null>(null);
  const lastBounds = useRef("");

  useEffect(() => {
    if (DEV_PREVIEW) {
      setState(DEV_PREVIEW);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<FloatState>("float:state", (event) => setState(event.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    // This window is created during Rust setup, before the main window has
    // mounted its bridge, so ask for a snapshot rather than waiting for the
    // next store change.
    void emitTo("main", "float:ready", null).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", state.dark);
    root.classList.remove("theme-blue", "theme-purple", "theme-green");
    if (state.colorTheme !== "black") root.classList.add(`theme-${state.colorTheme}`);
  }, [state.dark, state.colorTheme]);

  // Resize/reposition the window: the right edge stays put, so the panel grows
  // leftwards out of the rail. The panel is absolutely positioned at a fixed
  // width, so it can be measured before the window has grown to fit it.
  const resizeWindow = useCallback((width: number, height: number) => {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (lastBounds.current === key) return;
    lastBounds.current = key;
    void invoke("set_float_bounds", { width, height }).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    const rail = railHeight(state.tasks.length);
    if (!openId) {
      resizeWindow(RAIL_WIDTH, rail);
      return;
    }
    const panel = panelRef.current;
    const panelHeight = panel
      ? Math.min(panel.scrollHeight, MAX_WINDOW_HEIGHT - PANEL_PAD * 2)
      : 0;
    resizeWindow(OPEN_WIDTH, Math.max(rail, panelHeight + PANEL_PAD * 2));
  }, [openId, state.tasks, resizeWindow]);

  // A task that disappears from the snapshot must not leave a stale panel open.
  useEffect(() => {
    if (openId && !state.tasks.some((task) => task.id === openId)) setOpenId(null);
  }, [openId, state.tasks]);

  useEffect(() => () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
  }, []);

  const acknowledge = (task: FloatTask) => {
    if (task.alertAt == null) return;
    setDismissed((prev) => ({ ...prev, [task.id]: task.alertAt as number }));
    // Stop the flash immediately, then tell the main window to retire the
    // alert so a finished task drops off the rail once it has been seen.
    void emitTo("main", "float:ack", task.id).catch(() => {});
  };

  const openPanel = (task: FloatTask) => {
    acknowledge(task);
    setOpenId((prev) => (prev === task.id ? null : task.id));
  };

  const jumpToSession = (task: FloatTask) => {
    acknowledge(task);
    setOpenId(null);
    void invoke("focus_main_and_select", { tabId: task.id }).catch(() => {});
  };

  const handleDotClick = (event: ReactMouseEvent<HTMLButtonElement>, task: FloatTask) => {
    // `detail` is the click count within the OS double-click interval, so a
    // slow double click still lands as a jump instead of being split into two
    // single clicks.
    if (event.detail > 1) {
      if (clickTimer.current !== null) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
      jumpToSession(task);
      return;
    }
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
      jumpToSession(task);
      return;
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      openPanel(task);
    }, DOUBLE_CLICK_MS);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dragging the shell (not a dot) moves the window and hands its position to
  // the user: later resizes keep the right edge and centre instead of snapping
  // back to the screen edge.
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    void invoke("float_take_over_position")
      .catch(() => {})
      .finally(() => {
        void getCurrentWindow().startDragging().catch(() => {});
      });
  };

  const labels = LABELS[state.locale] ?? LABELS.zh;
  const openTask = openId ? state.tasks.find((task) => task.id === openId) ?? null : null;

  return (
    <div className="fl-root" onPointerDown={beginDrag}>
      {openTask && (
        <div className="fl-panel" ref={panelRef}>
          <div className="fl-panel-head">
            <span className="fl-panel-title">{openTask.title}</span>
            {openTask.action && <span className="fl-panel-action">{openTask.action}</span>}
          </div>

          {openTask.todoTotal > 0 ? (
            <>
              <div className="fl-progress" aria-hidden="true">
                <span
                  style={{ width: `${Math.round((openTask.todoDone / openTask.todoTotal) * 100)}%` }}
                />
              </div>
              <div className="fl-panel-count">
                {labels.todos} {openTask.todoDone}/{openTask.todoTotal}
              </div>
              <ul className="fl-todos">
                {openTask.todos.map((todo, index) => {
                  const active = todo.status === "in_progress";
                  const text = active ? (todo.activeForm || todo.content) : todo.content;
                  return (
                    <li key={`${index}-${todo.content}`} className={`fl-todo fl-todo-${todo.status}`}>
                      <span className="fl-todo-mark" aria-hidden="true">
                        {todo.status === "completed" ? "✓" : active ? <span className="fl-todo-spin" /> : ""}
                      </span>
                      <span className="fl-todo-text">{text}</span>
                      {active && <span className="fl-todo-tag">{labels.inProgress}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="fl-panel-empty">{labels.noTodos}</div>
          )}

          <div className="fl-panel-foot">
            <button type="button" className="fl-open" onClick={() => jumpToSession(openTask)}>
              {labels.open}
            </button>
            <span className="fl-hint">{labels.hint}</span>
          </div>
        </div>
      )}

      <div className="fl-rail">
        {state.tasks.length === 0 ? (
          <span className="fl-idle" title={labels.empty} aria-hidden="true" />
        ) : (
          state.tasks.map((task) => {
            const alerting = task.alertAt != null && dismissed[task.id] !== task.alertAt;
            return (
              <button
                key={task.id}
                type="button"
                className={
                  `fl-dot-btn fl-dot-${task.phase}`
                  + (alerting ? " fl-dot-alert" : "")
                  + (openId === task.id ? " fl-dot-open" : "")
                }
                onClick={(event) => handleDotClick(event, task)}
                title={
                  `${task.title}${task.action ? ` — ${task.action}` : ""}\n${labels.hint}`
                }
                aria-label={task.title}
              >
                <span className="fl-dot" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

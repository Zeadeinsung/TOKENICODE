/**
 * Wire format for the `float:state` event the main window pushes to the strip.
 *
 * This module is types-only on purpose: the strip's webview is a separate JS
 * context, so anything it imports must not reach a store, a Tauri command, or
 * any other module that assumes it runs inside the main window.
 */

export type FloatPhase = "running" | "awaiting" | "completed" | "error" | "todo";

export type FloatAlertKind = "awaiting" | "completed" | "error";

export type FloatTodoStatus = "pending" | "in_progress" | "completed";

export interface FloatTodo {
  content: string;
  status: FloatTodoStatus;
  /** Present for in-progress items — Claude's own active-form wording. */
  activeForm?: string;
}

export interface FloatTask {
  /** Session tab id, echoed back to the main window on click. */
  id: string;
  title: string;
  /** Most recent user prompt in the session, single-line and truncated. */
  prompt: string;
  /** What the agent is doing right now, already localized in the main window
   *  (e.g. 运行命令：npm run build). Empty when there is no activity. */
  action: string;
  /** Latest todo list for this task, newest TodoWrite wins. */
  todos: FloatTodo[];
  todoDone: number;
  todoTotal: number;
  phase: FloatPhase;
  /** When the alert was raised. Doubles as the identity of the alert: the
   *  strip treats `(id, alertAt)` as the read/unread key so a fresh alert on
   *  the same task lights up again. */
  alertAt: number | null;
  alertKind: FloatAlertKind | null;
}

export interface FloatState {
  tasks: FloatTask[];
  dark: boolean;
  colorTheme: "black" | "blue" | "purple" | "green";
  locale: "zh" | "en";
}

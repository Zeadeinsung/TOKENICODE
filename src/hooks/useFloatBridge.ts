import { useEffect } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { isSessionBusy, useChatStore, type TabSession } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { FloatAlertKind, FloatPhase, FloatState, FloatTask, FloatTodo } from '../floating/types';
import { describeActivity, latestPendingTool, thinkingSummary } from '../lib/activity-text';
import { extractCcTasks } from '../lib/cc-tasks';

/**
 * Feeds the floating tasks strip.
 *
 * The strip is a second webview with its own JS context, so it cannot read the
 * stores itself — doing so would instantiate a second zustand, and the
 * persisted stores would then have two writers on one localStorage key. Instead
 * the main window derives a small snapshot here and pushes it.
 *
 * Two filters keep that push from becoming an IPC flood:
 *  1. a cheap signature check, so token-level `partialText` churn bails out
 *     before any snapshot is built;
 *  2. a throttle on the emit itself.
 */

const EMIT_INTERVAL_MS = 200;

/** Latest raised alert per tab. Cleared when the tab goes busy again, or when
 *  the user acknowledges the row from the strip. */
const alerts = new Map<string, { kind: FloatAlertKind; at: number }>();
/** When a tab finished its last turn, so its dot can stay green/red on the rail
 *  long enough to be noticed. Only set on a busy → finished transition, so
 *  sessions restored from disk in a finished state never light up. */
const finishedAt = new Map<string, { at: number; kind: 'completed' | 'error' }>();
/** Whether the tab was executing on the previous pass, to detect that
 *  transition. */
const wasBusy = new Map<string, boolean>();
const FINISHED_TTL_MS = 10 * 60_000;
/** Previous `phase|status` per tab, so an alert only fires on a transition. */
const lastSig = new Map<string, string>();
/** Last user prompt per tab, keyed by message count — rebuilding it is the only
 *  O(messages) step here and it must not run per token. */
const promptCache = new Map<string, { len: number; prompt: string }>();
/** Checklist per tab, keyed by message count: it only changes when a task or
 *  TodoWrite message lands, so the replay is skipped otherwise. */
const todoCache = new Map<string, { len: number; todos: FloatTodo[] }>();

/** Index of the newest user prompt; tasks touched before it are older turns. */
function lastUserPromptIndex(tab: TabSession): number {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const message = tab.messages[i];
    if (message?.role === 'user' && message.type !== 'tool_result') return i;
  }
  return -1;
}

function cachedTodos(tabId: string, tab: TabSession): FloatTodo[] {
  const cached = todoCache.get(tabId);
  if (cached && cached.len === tab.messages.length) return cached.todos;

  // Claude Code 2.1.x uses TaskCreate / TaskUpdate instead of TodoWrite.
  // Replay the whole session to learn each task's subject, then keep only the
  // ones this turn created or updated.
  // Keep this turn's tasks plus any unfinished task carried over from an
  // earlier turn; drop tasks that were completed before this turn started.
  const sinceIndex = lastUserPromptIndex(tab);
  const allTasks = extractCcTasks(tab.messages);
  const currentTasks = sinceIndex >= 0
    ? extractCcTasks(tab.messages, sinceIndex, true)
    : allTasks;
  const taskToolTodos: FloatTodo[] = currentTasks.map((task) => ({
    content: task.content,
    status: task.status,
    activeForm: task.activeForm,
  }));

  // A session that uses TaskCreate must not fall back to a TodoWrite snapshot:
  // that snapshot still lists tasks from earlier turns.
  const todos = allTasks.length > 0 ? taskToolTodos : latestTodos(tab, sinceIndex);
  todoCache.set(tabId, { len: tab.messages.length, todos });
  return todos;
}

const MAX_PROMPT = 80;

/** Newest TodoWrite wins; earlier ones are snapshots of the same list. */
function latestTodos(tab: TabSession, sinceIndex: number): FloatTodo[] {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const message = tab.messages[i];
    if (message?.type !== 'todo' || !Array.isArray(message.todoItems)) continue;
    // The newest snapshot predates this turn: it belongs to an older task list.
    if (i <= sinceIndex) return [];
    return message.todoItems.map((item) => ({
      content: String(item.content ?? ''),
      status: item.status,
      activeForm: item.activeForm,
    }));
  }
  return [];
}

function todoSignature(todos: FloatTodo[]): string {
  let done = 0;
  const parts = todos.map((todo) => {
    if (todo.status === 'completed') done++;
    return `${todo.status}:${todo.content.length}`;
  });
  return `${done}/${todos.length}|${parts.join(',')}`;
}

/** One line describing what this tab is doing, already localized. */
function taskAction(tab: TabSession, busy: boolean): string {
  const phase = tab.activityStatus?.phase ?? 'idle';
  const pending = latestPendingTool(tab.messages);
  // Background tabs never enter the 'tool' phase, so a pending tool call is the
  // only evidence that they are executing something. Trust it while busy.
  const effectivePhase = phase === 'tool' || (busy && pending) ? 'tool' : phase;
  return describeActivity({
    phase: effectivePhase,
    toolName: pending?.name ?? tab.activityStatus?.toolName,
    detail: tab.activityStatus?.detail,
    partialThinking: tab.partialThinking,
    partialText: tab.partialText,
    pendingTool: pending,
  });
}

function lastUserPrompt(tabId: string, tab: TabSession): string {
  const cached = promptCache.get(tabId);
  if (cached && cached.len === tab.messages.length) return cached.prompt;

  let raw = '';
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m = tab.messages[i];
    if (m.role === 'user' && m.type === 'text' && m.content.trim()) {
      raw = m.content;
      break;
    }
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const prompt = oneLine.length > MAX_PROMPT ? `${oneLine.slice(0, MAX_PROMPT)}…` : oneLine;
  promptCache.set(tabId, { len: tab.messages.length, prompt });
  return prompt;
}

function titleFor(
  tabId: string,
  byId: Map<string, { id: string; project: string; projectDir: string }>,
  customPreviews: Record<string, string>,
  displayName: (id: string) => string,
): string {
  const session = byId.get(tabId);
  if (session) {
    return displayName(session.id) || session.project || session.projectDir || tabId;
  }
  // Tabs can hold draft ids that are not in the session list yet.
  return customPreviews[tabId] || tabId;
}

/** A cheap fingerprint of everything the strip cares about. Unchanged means
 *  the stream is just appending tokens and nothing needs recomputing. */
function signature(): string {
  const chat = useChatStore.getState();
  const sess = useSessionStore.getState();
  const parts: string[] = [String(sess.sessions.length)];
  for (const key of Object.keys(sess.customPreviews)) {
    parts.push(`${key}:${sess.customPreviews[key].length}`);
  }
  for (const [tabId, tab] of chat.tabs) {
    if (!tab.sessionMeta?.stdinId) continue;
    const todos = cachedTodos(tabId, tab);
    parts.push(
      `${tabId}|${tab.messages.length}|${tab.sessionStatus}|${tab.activityStatus?.phase ?? ''}`
      + `|${tab.activityStatus?.detail ?? ''}`
      + `|${thinkingSummary(tab.partialThinking, 24)}`
      + `|${todoSignature(todos)}`,
    );
  }
  return parts.join('\n');
}

function buildState(): FloatTask[] {
  const chat = useChatStore.getState();
  const sess = useSessionStore.getState();
  const now = Date.now();

  const byId = new Map(sess.sessions.map((s) => [s.id, s]));
  const displayName = (id: string) => {
    const s = byId.get(id);
    return s ? sess.getDisplayName(s) : '';
  };

  const tasks: FloatTask[] = [];

  for (const [tabId, tab] of chat.tabs) {
    if (!tab.sessionMeta?.stdinId) {
      alerts.delete(tabId);
      finishedAt.delete(tabId);
      wasBusy.delete(tabId);
      lastSig.delete(tabId);
      promptCache.delete(tabId);
      todoCache.delete(tabId);
      continue;
    }

    const activityPhase = tab.activityStatus?.phase;
    const status = tab.sessionStatus;
    const awaiting = activityPhase === 'awaiting';
    // `awaiting` is not busy: the process is alive but it is the user's turn.
    const busy =
      !awaiting &&
      (isSessionBusy(status) ||
        activityPhase === 'thinking' ||
        activityPhase === 'writing' ||
        activityPhase === 'tool');

    const sig = `${activityPhase ?? ''}|${status}`;
    if (busy) {
      // A new turn started: the previous alert is stale. Still record the
      // signature, so finishing this turn counts as a fresh transition.
      alerts.delete(tabId);
      finishedAt.delete(tabId);
      wasBusy.set(tabId, true);
    } else {
      // Busy → finished: keep the dot coloured for a while so "done" (green) or
      // "failed" (red) is visible without opening the app.
      if (wasBusy.get(tabId) && (status === 'completed' || status === 'error')) {
        finishedAt.set(tabId, { at: now, kind: status });
      }
      wasBusy.set(tabId, false);
      const kind: FloatAlertKind | null = awaiting
        ? 'awaiting'
        : status === 'completed'
          ? 'completed'
          : status === 'error'
            ? 'error'
            : null;
      if (kind && lastSig.get(tabId) !== sig) {
        alerts.set(tabId, { kind, at: now });
      }
    }
    lastSig.set(tabId, sig);

    const alert = alerts.get(tabId) ?? null;
    const finished = finishedAt.get(tabId) ?? null;
    const finishedFresh = finished != null && now - finished.at < FINISHED_TTL_MS;
    if (finished && !finishedFresh) finishedAt.delete(tabId);

    const todos = cachedTodos(tabId, tab);
    const todoTotal = todos.length;
    const todoDone = todos.filter((todo) => todo.status === 'completed').length;
    const hasOpenTodos = todoTotal > 0 && todoDone < todoTotal;
    // Idle tabs stay on the rail while they still have open todos, so the
    // checklist the user asked to keep visible doesn't vanish between turns.
    if (!busy && !alert && !hasOpenTodos && !finishedFresh) continue;

    const dot: FloatPhase = busy
      ? 'running'
      : alert?.kind === 'error'
        ? 'error'
        : alert?.kind === 'awaiting'
          ? 'awaiting'
          : alert?.kind === 'completed'
            ? 'completed'
            : finishedFresh && finished
              ? finished.kind
              : hasOpenTodos
                ? 'todo'
                : 'completed';

    tasks.push({
      id: tabId,
      title: titleFor(tabId, byId, sess.customPreviews, displayName),
      prompt: lastUserPrompt(tabId, tab),
      action: taskAction(tab, busy),
      todos,
      todoDone,
      todoTotal,
      phase: dot,
      alertAt: alert?.at ?? null,
      alertKind: alert?.kind ?? null,
    });
  }

  return tasks;
}

function chromePayload(): Pick<FloatState, 'dark' | 'colorTheme' | 'locale'> {
  const { theme, colorTheme, locale } = useSettingsStore.getState();
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return { dark, colorTheme, locale };
}

export function useFloatBridge(): void {
  useEffect(() => {
    let lastSignature = '';
    let lastPayload = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const push = () => {
      timer = null;
      const state: FloatState = { tasks: buildState(), ...chromePayload() };
      const payload = JSON.stringify(state);
      if (payload === lastPayload) return;
      lastPayload = payload;
      void emitTo('float', 'float:state', state).catch(() => {});
    };

    const schedule = () => {
      const sig = signature();
      if (sig === lastSignature) return;
      lastSignature = sig;
      if (timer === null) timer = setTimeout(push, EMIT_INTERVAL_MS);
    };

    const unsubChat = useChatStore.subscribe(schedule);
    const unsubSess = useSessionStore.subscribe(schedule);
    const unsubSettings = useSettingsStore.subscribe(schedule);

    // Clicking a row drops its alert, so a finished task leaves the strip once
    // seen. Re-push immediately rather than waiting for the next store change.
    const unlistenAck = listen<string>('float:ack', (event) => {
      alerts.delete(event.payload);
      lastSignature = '';
      schedule();
    });

    // Collapsing from the strip must flip the persisted toggle too.
    const unlistenCollapsed = listen('float:collapsed', () => {
      if (useSettingsStore.getState().floatStripEnabled) {
        useSettingsStore.getState().setFloatStripEnabled(false);
      }
    });

    // Rust has already unminimised and focused the main window by this point;
    // all that is left is to switch the visible session.
    const unlistenSelect = listen<string>('float:select', (event) => {
      switchToTab(event.payload);
    });

    // The strip mounts after this hook, so its first frames would be dropped.
    // It announces itself and we re-send from scratch.
    const unlistenReady = listen('float:ready', () => {
      lastSignature = '';
      lastPayload = '';
      schedule();
    });

    schedule();

    // A finished dot expires after a TTL; re-derive once a minute so it leaves
    // the rail even when no store changes happen.
    const expiryTimer = setInterval(() => {
      lastSignature = '';
      schedule();
    }, 60_000);

    return () => {
      unsubChat();
      unsubSess();
      unsubSettings();
      clearInterval(expiryTimer);
      if (timer !== null) clearTimeout(timer);
      void unlistenAck.then((f) => f());
      void unlistenCollapsed.then((f) => f());
      void unlistenSelect.then((f) => f());
      void unlistenReady.then((f) => f());
    };
  }, []);
}

/** Same sequence the session list uses when a row is clicked. */
function switchToTab(tabId: string): void {
  const session = useSessionStore.getState().sessions.find((s) => s.id === tabId);
  useSessionStore.getState().setSelectedSession(tabId);
  if (useChatStore.getState().restoreFromCache(tabId)) {
    useAgentStore.getState().restoreFromCache(tabId);
  }
  if (session?.project) {
    useSettingsStore.getState().setWorkingDirectory(session.project);
  }
}

/** Show/hide the strip whenever the persisted toggle changes. */
export function useFloatVisibility(): void {
  useEffect(() => {
    const apply = (enabled: boolean) => {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_float_visible', { visible: enabled }))
        .catch(() => {});
    };
    apply(useSettingsStore.getState().floatStripEnabled);
    return useSettingsStore.subscribe((state, prev) => {
      if (state.floatStripEnabled === prev.floatStripEnabled) return;
      apply(state.floatStripEnabled);
    });
  }, []);
}

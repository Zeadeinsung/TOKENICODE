import type { ChatMessage } from '../stores/chatStore';

/**
 * Claude Code 2.1.x replaced TodoWrite with the TaskCreate / TaskUpdate tool
 * pair. The transcript only carries tool calls, so the checklist is rebuilt by
 * replaying them:
 *
 *   TaskCreate { subject, activeForm }            → a new pending item
 *   TaskUpdate { taskId, status, subject?, ... }  → status/name change
 *
 * TaskCreate only learns its real id from its tool result
 * (`{"task":{"id":…,"subject":…}}`). When that result has not landed yet the
 * item is keyed `tmp:<toolUseId>` and adopted by the first TaskUpdate that
 * mentions a real id.
 */

export interface CcTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export function isTaskTool(toolName?: string): boolean {
  return !!toolName && TASK_TOOLS.has(toolName);
}

function parseTaskIdFromResult(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  // Result text may wrap the JSON in a sentence; parse from the first `{` to
  // the last `}` (nested objects mean the last `{` alone is not the root).
  const candidates: Array<[number, number]> = [
    [text.indexOf('{'), text.lastIndexOf('}')],
    [text.lastIndexOf('{'), text.lastIndexOf('}')],
  ];
  for (const [start, end] of candidates) {
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      const id = parsed?.task?.id ?? parsed?.taskId;
      if (typeof id === 'string' && id) return id;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Give the newest unkeyed create the real id an update just revealed. */
function adoptUnkeyed(tasks: Map<string, CcTask>, taskId: string): CcTask | null {
  const list = Array.from(tasks.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (!item.id.startsWith('tmp:')) continue;
    tasks.delete(item.id);
    item.id = taskId;
    tasks.set(taskId, item);
    return item;
  }
  return null;
}

/**
 * Replay the task tool calls in `messages` and return the current checklist.
 * Messages must be in transcript order; later updates win.
 */
export function extractCcTasks(
  messages: ChatMessage[],
  sinceIndex?: number,
  includeUnfinished = false,
): CcTask[] {
  const tasks = new Map<string, CcTask>();
  // Last message index that created or touched each task. Replaying the whole
  // session is still required to know a task's subject after it was created in
  // an earlier turn; `sinceIndex` then drops tasks this turn never touched.
  const touched = new Map<string, number>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.type !== 'tool_use') continue;

    if (message.toolName === 'TaskCreate') {
      const subject = String(message.toolInput?.subject ?? '').trim();
      if (!subject) continue;
      const activeForm = typeof message.toolInput?.activeForm === 'string'
        ? message.toolInput.activeForm
        : undefined;
      const realId = parseTaskIdFromResult(message.toolResultContent);
      const id = realId ?? `tmp:${message.id}`;
      tasks.set(id, { id, content: subject, status: 'pending', activeForm });
      touched.set(id, index);
      continue;
    }

    if (message.toolName === 'TaskUpdate') {
      const taskId = String(message.toolInput?.taskId ?? '');
      if (!taskId) continue;
      const status = message.toolInput?.status;

      if (status === 'deleted') {
        tasks.delete(taskId);
        touched.delete(taskId);
        continue;
      }

      let item = tasks.get(taskId) ?? adoptUnkeyed(tasks, taskId);
      if (!item) {
        // No create seen for this id (transcript tail, or an old session):
        // record it anyway so the checklist stays representative.
        const subject = typeof message.toolInput?.subject === 'string' && message.toolInput.subject.trim()
          ? message.toolInput.subject.trim()
          : `任务 ${taskId}`;
        item = { id: taskId, content: subject, status: 'pending' };
        tasks.set(taskId, item);
      }

      if (status === 'pending' || status === 'in_progress' || status === 'completed') {
        item.status = status;
      }
      if (typeof message.toolInput?.subject === 'string' && message.toolInput.subject.trim()) {
        item.content = message.toolInput.subject.trim();
      }
      if (typeof message.toolInput?.activeForm === 'string') {
        item.activeForm = message.toolInput.activeForm;
      }
      touched.set(item.id, index);
    }
  }

  const result = Array.from(tasks.values());
  if (sinceIndex === undefined) return result;
  // This turn's tasks, plus anything still open from earlier turns — an
  // unfinished task from a previous prompt is still current work.
  return result.filter((task) => {
    if ((touched.get(task.id) ?? -1) > sinceIndex) return true;
    return includeUnfinished && task.status !== 'completed';
  });
}

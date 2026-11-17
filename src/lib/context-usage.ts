import { bridge } from './tauri-bridge';
import { useChatStore } from '../stores/chatStore';

/**
 * `/context` support.
 *
 * The CLI answers `/context` with a synthetic assistant message carrying a
 * `context_usage` object. It is a local command: no model call happens. The
 * stream processor intercepts that message (it is not rendered into the chat)
 * and stores the parsed breakdown on the tab, so the header's Ctx bar can open
 * a detail panel without polluting the transcript.
 */

export interface ContextCategory {
  name: string;
  tokens: number;
  kind?: 'used' | 'buffer' | 'free' | string;
}

export interface ContextMemoryFile {
  path: string;
  type?: string;
  tokens: number;
}

export interface ContextAgent {
  agentType: string;
  source?: string;
  tokens: number;
}

export interface ContextSkill {
  name: string;
  source?: string;
  tokens: number;
}

export interface ContextUsageDetail {
  model?: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: ContextCategory[];
  memoryFiles: ContextMemoryFile[];
  agents: ContextAgent[];
  skills: ContextSkill[];
  /** When the breakdown was received (Date.now()). */
  fetchedAt: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Context actually occupying the window for a model call.
 *
 * `input_tokens` alone is only the uncached delta — with prompt caching most of
 * the conversation arrives as `cache_read_input_tokens`, so using the raw
 * input count makes a long session look empty right after a compaction.
 */
export function contextTokensFromUsage(usage: any): number {
  if (!usage || typeof usage !== 'object') return 0;
  return num(usage.input_tokens)
    + num(usage.cache_read_input_tokens)
    + num(usage.cache_creation_input_tokens);
}

/** Normalise the CLI's snake_case `context_usage` payload. */
export function parseContextUsage(raw: any): ContextUsageDetail | null {
  if (!raw || typeof raw !== 'object') return null;

  const categories: ContextCategory[] = Array.isArray(raw.categories)
    ? raw.categories.map((item: any) => ({
        name: String(item?.name ?? ''),
        tokens: num(item?.tokens),
        kind: typeof item?.kind === 'string' ? item.kind : undefined,
      })).filter((item: ContextCategory) => item.name)
    : [];

  const memoryFiles: ContextMemoryFile[] = Array.isArray(raw.memory_files)
    ? raw.memory_files.map((item: any) => ({
        path: String(item?.path ?? ''),
        type: typeof item?.type === 'string' ? item.type : undefined,
        tokens: num(item?.tokens),
      })).filter((item: ContextMemoryFile) => item.path)
    : [];

  const agents: ContextAgent[] = Array.isArray(raw.agents)
    ? raw.agents.map((item: any) => ({
        agentType: String(item?.agent_type ?? ''),
        source: typeof item?.source === 'string' ? item.source : undefined,
        tokens: num(item?.tokens),
      })).filter((item: ContextAgent) => item.agentType)
    : [];

  const skills: ContextSkill[] = Array.isArray(raw.skills)
    ? raw.skills.map((item: any) => ({
        name: String(item?.name ?? ''),
        source: typeof item?.source === 'string' ? item.source : undefined,
        tokens: num(item?.tokens),
      })).filter((item: ContextSkill) => item.name)
    : [];

  const totalTokens = num(raw.total_tokens);
  const maxTokens = num(raw.raw_max_tokens);
  if (totalTokens === 0 && maxTokens === 0 && categories.length === 0) return null;

  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    totalTokens,
    maxTokens,
    percentage: num(raw.percentage),
    categories,
    memoryFiles,
    agents,
    skills,
    fetchedAt: Date.now(),
  };
}

/**
 * Real context window reported by the CLI in `result.modelUsage`.
 *
 * The app guesses 200K vs 1M from the model id, which is wrong for proxied
 * models (a DeepSeek model with CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 reports
 * 1M here). Keys are model ids as the CLI saw them, so fall back to a loose
 * match and then to the largest reported window.
 */
export function contextWindowFromModelUsage(modelUsage: any, preferredModel?: string): number {
  if (!modelUsage || typeof modelUsage !== 'object') return 0;

  const wanted = (preferredModel || '').toLowerCase().replace(/\[1m\]$/, '');
  let largest = 0;
  for (const [name, info] of Object.entries<any>(modelUsage)) {
    const window = num(info?.contextWindow);
    if (window <= 0) continue;
    const key = name.toLowerCase();
    if (wanted && (key === wanted || key.includes(wanted) || wanted.includes(key))) return window;
    if (window > largest) largest = window;
  }
  return largest;
}

export type ContextRequestResult =
  | { ok: true }
  | { ok: false; reason: 'no-session' | 'busy' | 'error'; message?: string };

/**
 * Ask the CLI for a fresh `/context` breakdown. Only sent when the session is
 * idle: the CLI answers local commands inline, and issuing one mid-turn would
 * interleave its result with the running turn.
 */
export async function requestContextUsage(tabId: string): Promise<ContextRequestResult> {
  const tab = useChatStore.getState().getTab(tabId);
  if (!tab?.sessionMeta.stdinId) return { ok: false, reason: 'no-session' };

  const status = tab.sessionStatus;
  if (status === 'running' || status === 'reconnecting' || status === 'stopping') {
    return { ok: false, reason: 'busy' };
  }

  try {
    await bridge.sendStdin(tab.sessionMeta.stdinId, '/context');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'error', message: (error as Error)?.message };
  }
}

/** Palette for the stacked usage bar. Falls back to the accent for unknown kinds. */
export function categoryColor(kind: string | undefined, index: number): string {
  if (kind === 'free') return 'var(--color-bg-tertiary)';
  if (kind === 'buffer') return 'var(--color-warning)';
  const palette = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];
  return palette[index % palette.length];
}

/**
 * Payload-pruning regression guard (Fix A for memory usage).
 *
 * Guards the contracts that keep the live UI's memory bounded:
 *   - tool results are capped at MAX_TOOL_RESULT chars
 *   - Write toolInput.content is reduced to a small preview on completion,
 *     with the full content parked in the plan-write cache until ExitPlanMode
 *   - Edit old/new strings are capped at MAX_EDIT_SNIPPET chars
 *   - the plan-write cache is consumed (and freed) when the plan-review card
 *     is built
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/tauri-bridge', () => ({
  bridge: {
    listSessions: vi.fn(() => Promise.resolve([])),
    loadCustomPreviews: vi.fn(() => Promise.resolve({})),
    saveCustomPreviews: vi.fn(() => Promise.resolve()),
    trackSession: vi.fn(() => Promise.resolve()),
  },
  onClaudeStream: vi.fn(() => Promise.resolve(() => {})),
  onClaudeStderr: vi.fn(() => Promise.resolve(() => {})),
  onSessionExit: vi.fn(() => Promise.resolve(() => {})),
}));

import { __pruningTesting } from '../useStreamProcessor';
import type { ChatMessage } from '../../stores/chatStore';

const {
  capText,
  pruneCompletedTool,
  resolvePlanContent,
  completedToolUpdates,
  MAX_TOOL_RESULT,
  MAX_WRITE_PREVIEW,
  MAX_EDIT_SNIPPET,
  planWriteCache,
} = __pruningTesting;

function writeMsg(content: string, id = 'toolu_write'): ChatMessage {
  return {
    id,
    role: 'assistant',
    type: 'tool_use',
    content: '',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/a.ts', content },
    timestamp: 0,
  };
}

function editMsg(oldS: string, newS: string): ChatMessage {
  return {
    id: 'toolu_edit',
    role: 'assistant',
    type: 'tool_use',
    content: '',
    toolName: 'Edit',
    toolInput: { file_path: '/tmp/a.ts', old_string: oldS, new_string: newS },
    timestamp: 0,
  };
}

beforeEach(() => {
  planWriteCache.clear();
});

describe('capText', () => {
  it('leaves short text untouched', () => {
    expect(capText('hello', 10)).toBe('hello');
  });

  it('truncates long text and marks the truncation', () => {
    const long = 'x'.repeat(100);
    const out = capText(long, 50);
    expect(out.slice(0, 50)).toBe('x'.repeat(50));
    expect(out).not.toBe(long);
    expect(out).toContain('truncated');
  });
});

describe('pruneCompletedTool', () => {
  it('caps a large Write content and parks the full content in the cache', () => {
    const full = 'y'.repeat(MAX_WRITE_PREVIEW + 5000);
    const msg = writeMsg(full);
    const updates = pruneCompletedTool('tab1', msg);

    expect(updates).not.toBeNull();
    const input = updates!.toolInput as Record<string, unknown>;
    expect((input.content as string).length).toBeLessThan(MAX_WRITE_PREVIEW + 100);
    expect(planWriteCache.get('tab1')).toBe(full);
  });

  it('leaves small Writes untouched and does not populate the cache', () => {
    const msg = writeMsg('small file');
    expect(pruneCompletedTool('tab1', msg)).toBeNull();
    expect(planWriteCache.has('tab1')).toBe(false);
  });

  it('caps oversized Edit old/new strings', () => {
    const big = 'z'.repeat(MAX_EDIT_SNIPPET + 1000);
    const updates = pruneCompletedTool('tab1', editMsg(big, 'new'));
    const input = updates!.toolInput as Record<string, unknown>;
    expect((input.old_string as string).length).toBeLessThan(MAX_EDIT_SNIPPET + 100);
    expect(input.new_string).toBe('new');
  });

  it('leaves normal-size Edit strings untouched', () => {
    expect(pruneCompletedTool('tab1', editMsg('old', 'new'))).toBeNull();
  });

  it('ignores non-Write/Edit tools', () => {
    const msg: ChatMessage = {
      id: 'toolu_bash',
      role: 'assistant',
      type: 'tool_use',
      content: '',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      timestamp: 0,
    };
    expect(pruneCompletedTool('tab1', msg)).toBeNull();
  });
});

describe('resolvePlanContent', () => {
  it('prefers the cached content and consumes it', () => {
    planWriteCache.set('tab1', 'FULL PLAN');
    expect(resolvePlanContent('tab1', [])).toBe('FULL PLAN');
    expect(planWriteCache.has('tab1')).toBe(false);
  });

  it('falls back to the last Write still carrying its content', () => {
    const msgs = [
      writeMsg('plan a', 'toolu_1'),
      writeMsg('plan b', 'toolu_2'),
    ];
    expect(resolvePlanContent('tab1', msgs)).toBe('plan b');
  });

  it('returns empty when no plan source exists', () => {
    expect(resolvePlanContent('tab1', [])).toBe('');
  });
});

describe('completedToolUpdates', () => {
  it('caps the result text and marks the tool completed', () => {
    const huge = 'r'.repeat(MAX_TOOL_RESULT + 5000);
    const updates = completedToolUpdates('tab1', writeMsg('small'), huge);
    expect(updates.toolCompleted).toBe(true);
    expect((updates.toolResultContent as string).length).toBeLessThan(MAX_TOOL_RESULT + 100);
  });

  it('does not set toolResultContent when the result is empty', () => {
    const updates = completedToolUpdates('tab1', writeMsg('small'), '');
    expect(updates.toolResultContent).toBeUndefined();
    expect(updates.toolCompleted).toBe(true);
  });

  it('prunes the tool input in the same update', () => {
    const full = 'w'.repeat(MAX_WRITE_PREVIEW + 1000);
    const updates = completedToolUpdates('tab1', writeMsg(full), 'ok');
    const input = updates.toolInput as Record<string, unknown>;
    expect((input.content as string).length).toBeLessThan(MAX_WRITE_PREVIEW + 100);
  });
});

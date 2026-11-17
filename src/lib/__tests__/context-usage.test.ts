import { describe, expect, it } from 'vitest';
import { contextTokensFromUsage, contextWindowFromModelUsage, parseContextUsage } from '../context-usage';

const PAYLOAD = {
  model: 'deepseek-flash',
  total_tokens: 24818,
  raw_max_tokens: 1000000,
  percentage: 2,
  categories: [
    { name: 'System prompt', tokens: 1607, kind: 'used' },
    { name: 'System tools', tokens: 18060, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 942182, kind: 'free' },
  ],
  mcp_tools: [],
  memory_files: [
    { path: 'C:\\Users\\33273\\.claude\\CLAUDE.md', type: 'User', tokens: 368 },
  ],
  agents: [
    { agent_type: 'frontend-mobile-development:frontend-developer', source: 'plugin', tokens: 93 },
  ],
  skills: [
    { name: 'dataviz', source: 'built-in', tokens: 482 },
  ],
};

describe('parseContextUsage', () => {
  it('normalises the CLI context_usage payload', () => {
    const usage = parseContextUsage(PAYLOAD);
    expect(usage).not.toBeNull();
    expect(usage!.model).toBe('deepseek-flash');
    expect(usage!.totalTokens).toBe(24818);
    expect(usage!.maxTokens).toBe(1_000_000);
    expect(usage!.percentage).toBe(2);
    expect(usage!.categories).toHaveLength(4);
    expect(usage!.memoryFiles[0].path).toContain('CLAUDE.md');
    expect(usage!.agents[0].agentType).toContain('frontend-developer');
    expect(usage!.skills[0].name).toBe('dataviz');
    expect(usage!.fetchedAt).toBeGreaterThan(0);
  });

  it('returns null for missing or empty payloads', () => {
    expect(parseContextUsage(null)).toBeNull();
    expect(parseContextUsage({})).toBeNull();
    expect(parseContextUsage('nope')).toBeNull();
  });

  it('drops malformed rows instead of throwing', () => {
    const usage = parseContextUsage({
      total_tokens: 10,
      raw_max_tokens: 100,
      categories: [{ name: '', tokens: 5 }, { name: 'Messages', tokens: 5 }],
      memory_files: [{ path: '' }],
      agents: [{ agent_type: '' }],
      skills: [{ name: '' }],
    });
    expect(usage!.categories).toHaveLength(1);
    expect(usage!.memoryFiles).toHaveLength(0);
    expect(usage!.agents).toHaveLength(0);
    expect(usage!.skills).toHaveLength(0);
  });
});

describe('contextTokensFromUsage', () => {
  it('counts cached prompt tokens, not just the uncached delta', () => {
    expect(contextTokensFromUsage({
      input_tokens: 857,
      cache_read_input_tokens: 57216,
      cache_creation_input_tokens: 0,
    })).toBe(58073);
  });

  it('handles partially cached and missing fields', () => {
    expect(contextTokensFromUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 30,
    })).toBe(40);
    expect(contextTokensFromUsage({ input_tokens: 27630 })).toBe(27630);
    expect(contextTokensFromUsage(null)).toBe(0);
    expect(contextTokensFromUsage({})).toBe(0);
  });
});

describe('contextWindowFromModelUsage', () => {
  it('reads the window the CLI actually used for the spawned model', () => {
    expect(contextWindowFromModelUsage(
      { 'deepseek-flash': { contextWindow: 1_000_000 } },
      'deepseek-flash',
    )).toBe(1_000_000);
  });

  it('matches ids that carry a [1m] suffix', () => {
    expect(contextWindowFromModelUsage(
      { 'claude-opus-4-8': { contextWindow: 1_000_000 } },
      'claude-opus-4-8[1m]',
    )).toBe(1_000_000);
  });

  it('falls back to the largest reported window without a match', () => {
    expect(contextWindowFromModelUsage({
      'model-a': { contextWindow: 200_000 },
      'model-b': { contextWindow: 1_000_000 },
    }, 'unknown-model')).toBe(1_000_000);
    expect(contextWindowFromModelUsage(null)).toBe(0);
    expect(contextWindowFromModelUsage({})).toBe(0);
  });
});

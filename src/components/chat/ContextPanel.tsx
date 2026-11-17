import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { useChatStore } from '../../stores/chatStore';
import { categoryColor, requestContextUsage } from '../../lib/context-usage';

/**
 * Context detail card, opened by clicking the Ctx bar in the chat header.
 *
 * Data comes from the CLI's `/context` local command: requesting it is a stdin
 * write, and useStreamProcessor stores the returned breakdown on the tab
 * instead of rendering it into the transcript.
 */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatShare(tokens: number, max: number): string {
  if (max <= 0) return '0%';
  const pct = (tokens / max) * 100;
  return pct >= 10 ? `${pct.toFixed(0)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : '<1%';
}

export function ContextPanel({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const t = useT();
  const usage = useChatStore((s) => s.tabs.get(tabId)?.sessionMeta.contextUsage);
  // Occupancy from the last turn (live stream or the JSONL when loaded from disk).
  // Saved sessions have no process to answer /context, so this is the only number
  // available until the session is resumed.
  const recordedTokens = useChatStore((s) => s.tabs.get(tabId)?.sessionMeta.contextTokens);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedAt = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    requestedAt.current = Date.now();
    const result = await requestContextUsage(tabId);
    if (result.ok) return;

    setLoading(false);
    setError(result.reason === 'no-session'
      ? t('ctx.noSession')
      : result.reason === 'busy'
        ? t('ctx.busy')
        : (result.message || t('ctx.error')));
  }, [tabId, t]);

  useEffect(() => {
    void refresh();
    // Only on open / tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    if (usage && usage.fetchedAt >= requestedAt.current) {
      setLoading(false);
      setError(null);
    }
  }, [usage]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setLoading(false);
      setError((prev) => prev ?? t('ctx.timeout'));
    }, 6000);
    return () => clearTimeout(timer);
  }, [loading, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const max = usage?.maxTokens || 0;
  const total = usage?.totalTokens || 0;
  const percent = usage?.percentage ?? (max > 0 ? Math.round((total / max) * 100) : 0);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 pt-[9vh]"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] max-h-[78vh] overflow-y-auto rounded-2xl border border-border-subtle bg-bg-primary shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-bg-primary px-5 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">{t('ctx.title')}</div>
            {usage?.model && (
              <div className="mt-0.5 truncate text-[11px] text-text-tertiary">{usage.model}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void refresh(); }}
              disabled={loading}
              className="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary transition-smooth hover:bg-bg-tertiary disabled:opacity-50"
            >
              {loading ? t('ctx.loading') : t('ctx.refresh')}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('ctx.close')}
              aria-label={t('ctx.close')}
              className="rounded-lg p-1 text-text-tertiary transition-smooth hover:bg-bg-tertiary hover:text-text-primary"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {usage ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-text-primary">
                  {formatTokens(total)}
                </span>
                <span className="text-sm text-text-tertiary">/ {formatTokens(max)}</span>
                <span className="ml-auto text-sm font-medium tabular-nums text-text-primary">
                  {percent}%
                </span>
              </div>

              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-bg-tertiary">
                {usage.categories.map((category, index) => (
                  <div
                    key={`${category.name}-${index}`}
                    style={{
                      width: max > 0 ? `${Math.max(0, (category.tokens / max) * 100)}%` : '0%',
                      background: categoryColor(category.kind, index),
                    }}
                  />
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-1">
                {usage.categories.map((category, index) => (
                  <div key={`${category.name}-row-${index}`} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-sm"
                      style={{ background: categoryColor(category.kind, index) }}
                    />
                    <span className="flex-1 truncate text-text-secondary">{category.name}</span>
                    <span className="w-16 text-right tabular-nums text-text-tertiary">
                      {formatTokens(category.tokens)}
                    </span>
                    <span className="w-12 text-right tabular-nums text-text-tertiary">
                      {formatShare(category.tokens, max)}
                    </span>
                  </div>
                ))}
              </div>

              {usage.memoryFiles.length > 0 && (
                <section className="mt-4">
                  <div className="mb-1 text-[11px] font-medium text-text-secondary">
                    {t('ctx.memoryFiles')}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {usage.memoryFiles.map((file) => (
                      <div key={file.path} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 truncate font-mono text-text-tertiary" title={file.path}>
                          {file.path}
                        </span>
                        <span className="tabular-nums text-text-tertiary">{formatTokens(file.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {usage.agents.length > 0 && (
                <section className="mt-4">
                  <div className="mb-1 text-[11px] font-medium text-text-secondary">
                    {t('ctx.agents')}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {usage.agents.map((agent) => (
                      <div key={agent.agentType} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 truncate text-text-tertiary">{agent.agentType}</span>
                        <span className="tabular-nums text-text-tertiary">{formatTokens(agent.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {usage.skills.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-[11px] font-medium text-text-secondary">
                    {t('ctx.skills')} ({usage.skills.length})
                  </summary>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {usage.skills.map((skill) => (
                      <div key={skill.name} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 truncate text-text-tertiary">{skill.name}</span>
                        <span className="tabular-nums text-text-tertiary">{formatTokens(skill.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="mt-4 text-[10px] text-text-tertiary">
                {t('ctx.updated').replace('{time}', new Date(usage.fetchedAt).toLocaleTimeString())}
              </div>
            </>
          ) : (
            <div className="py-8 text-center text-xs text-text-tertiary">
              <div>{loading ? t('ctx.loading') : (error || t('ctx.noSession'))}</div>
              {!loading && recordedTokens ? (
                <div className="mt-2 text-[11px] text-text-secondary">
                  {t('ctx.recorded').replace('{tokens}', formatTokens(recordedTokens))}
                </div>
              ) : null}
            </div>
          )}

          {error && usage && (
            <div className="mt-3 text-[11px] text-warning">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}

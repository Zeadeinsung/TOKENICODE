import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { bridge, type MessageHit } from '../../lib/tauri-bridge';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';

const RESULT_LIMIT = 100;
const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

/** Open state lives outside the panel so the toolbar button and the shortcut
 *  can both drive it without threading a prop through App. */
export const useGlobalSearchStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

function formatHitTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Split a snippet on the query so the matched text can be emphasised. */
function Snippet({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    if (!query) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let pos = 0;
    while (pos < text.length) {
      const idx = lower.indexOf(needle, pos);
      if (idx === -1) {
        out.push({ text: text.slice(pos), hit: false });
        break;
      }
      if (idx > pos) out.push({ text: text.slice(pos, idx), hit: false });
      out.push({ text: text.slice(idx, idx + needle.length), hit: true });
      pos = idx + needle.length;
    }
    return out;
  }, [text, query]);

  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-amber-400/40 text-inherit rounded-[2px] px-px">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function GlobalSearchPanel() {
  const t = useT();
  const open = useGlobalSearchStore((s) => s.open);
  const setOpen = useGlobalSearchStore((s) => s.setOpen);
  const toggle = useGlobalSearchStore((s) => s.toggle);
  const onClose = useCallback(() => setOpen(false), [setOpen]);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const customPreviews = useSessionStore((s) => s.customPreviews);
  const requestReveal = useSessionStore((s) => s.requestReveal);

  // Ctrl/Cmd+Shift+F. Plain Ctrl+F belongs to the in-conversation find bar and
  // Ctrl+K to the command palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggle]);

  const sessionLabel = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return id.slice(0, 8);
      return customPreviews[s.id] || s.preview || s.project || s.projectDir || id.slice(0, 8);
    },
    [sessions, customPreviews],
  );

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setSelectedIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  // Debounced search, guarded against out-of-order responses
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await bridge.searchMessages(q, RESULT_LIMIT);
        if (cancelled) return;
        setHits(rows);
        setSelectedIndex(0);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  const activate = useCallback(
    (hit: MessageHit) => {
      requestReveal(hit.session_id, hit.uuid);
      onClose();
    },
    [requestReveal, onClose],
  );

  // Keep the highlighted row in view while arrowing through results
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (hits.length) setSelectedIndex((i) => Math.min(i + 1, hits.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (hits.length) setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && hits[selectedIndex]) {
        e.preventDefault();
        activate(hits[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [hits, selectedIndex, activate, onClose],
  );

  if (!open) return null;

  const trimmed = query.trim();

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      <div className="relative w-full max-w-2xl mx-4 rounded-2xl
        bg-bg-primary border border-border-subtle shadow-2xl
        overflow-hidden animate-fade-in flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="text-text-tertiary flex-shrink-0">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-sm text-text-primary
              placeholder:text-text-tertiary outline-none"
          />
          {searching ? (
            <span className="text-[11px] text-text-tertiary flex-shrink-0">
              {t('search.searching')}
            </span>
          ) : trimmed.length >= MIN_QUERY ? (
            <span className="text-[11px] text-text-tertiary flex-shrink-0 tabular-nums">
              {t('search.resultCount').replace('{count}', String(hits.length))}
            </span>
          ) : null}
          <button
            onClick={onClose}
            title={t('search.close')}
            className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary
              transition-colors flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5 min-h-0">
          {trimmed.length < MIN_QUERY ? (
            <div className="px-4 py-6 text-center text-xs text-text-tertiary">
              {t('search.hint')}
            </div>
          ) : hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-text-tertiary">
              {searching ? t('search.searching') : t('search.noResults')}
            </div>
          ) : (
            <>
              {hits.length >= RESULT_LIMIT && (
                <div className="px-4 py-1 text-[10px] text-text-tertiary">
                  {t('search.truncated').replace('{count}', String(RESULT_LIMIT))}
                </div>
              )}
              {hits.map((hit, i) => (
                <button
                  key={`${hit.session_id}:${hit.uuid}`}
                  data-hit-index={i}
                  onClick={() => activate(hit)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2 transition-smooth
                    ${i === selectedIndex ? 'bg-accent/10' : 'hover:bg-bg-secondary'}`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[11px] font-medium text-text-secondary truncate max-w-[60%]">
                      {sessionLabel(hit.session_id)}
                    </span>
                    <span className={`text-[10px] px-1.5 rounded flex-shrink-0
                      ${hit.role === 'user'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bg-tertiary text-text-tertiary'}`}>
                      {hit.role === 'user' ? t('search.roleUser') : t('search.roleAssistant')}
                    </span>
                    <span className="text-[10px] text-text-tertiary ml-auto flex-shrink-0 tabular-nums">
                      {formatHitTime(hit.timestamp)}
                    </span>
                  </div>
                  <div className="text-xs text-text-primary leading-snug line-clamp-2">
                    <Snippet text={hit.snippet} query={trimmed} />
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

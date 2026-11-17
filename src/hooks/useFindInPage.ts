import { useState, useCallback, useEffect, useRef } from 'react';

const MARK_BG = 'rgba(255, 200, 0, 0.45)';
const MARK_BG_ACTIVE = 'rgba(255, 140, 0, 0.7)';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the matcher for a query. Both modes go through RegExp so the literal
 *  path and the regex path share one scan; an invalid pattern yields null,
 *  which the caller reports as "no matches" rather than throwing. */
function buildPattern(query: string, caseSensitive: boolean, regex: boolean): RegExp | null {
  if (!query) return null;
  try {
    return new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/**
 * Lightweight Cmd+F find-in-page for chat panels.
 * Uses TreeWalker to find text nodes, wraps matches in <mark>, and scrolls to current match.
 */
export function useFindInPage(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);
  const marksRef = useRef<HTMLElement[]>([]);

  // Clear all highlights
  const clearMarks = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const marks = container.querySelectorAll('mark[data-find]');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize(); // merge adjacent text nodes
      }
    });
    marksRef.current = [];
    setMatchCount(0);
    setMatchIndex(0);
  }, [containerRef]);

  // Highlight all matches
  const highlight = useCallback((searchText: string) => {
    clearMarks();
    const container = containerRef.current;
    if (!container || !searchText) {
      setIsInvalid(false);
      return;
    }

    const pattern = buildPattern(searchText, caseSensitive, regex);
    if (!pattern) {
      setIsInvalid(regex);
      return;
    }
    setIsInvalid(false);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip nodes inside input/textarea/contenteditable
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.tagName === 'MARK' && el.hasAttribute('data-find')) return NodeFilter.FILTER_REJECT;
        if (el.closest('input, textarea, [contenteditable="true"], .tiptap')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const hits: HTMLElement[] = [];
    const nodesToProcess: { node: Text; ranges: [number, number][] }[] = [];

    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
      const text = textNode.textContent || '';
      pattern.lastIndex = 0;
      const ranges: [number, number][] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        // A zero-length match (e.g. `^` or `a*`) would otherwise spin forever.
        if (m[0].length === 0) {
          pattern.lastIndex++;
          continue;
        }
        ranges.push([m.index, m.index + m[0].length]);
      }
      if (ranges.length > 0) {
        nodesToProcess.push({ node: textNode, ranges });
      }
    }

    // Process in reverse to avoid invalidating earlier nodes
    for (const { node, ranges } of nodesToProcess) {
      const text = node.textContent || '';
      const parent = node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      let lastEnd = 0;
      for (const [start, end] of ranges) {
        if (start > lastEnd) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd, start)));
        }
        const mark = document.createElement('mark');
        mark.setAttribute('data-find', '');
        mark.style.cssText = `background: ${MARK_BG}; color: inherit; border-radius: 2px; padding: 0 1px;`;
        mark.textContent = text.slice(start, end);
        frag.appendChild(mark);
        hits.push(mark);
        lastEnd = end;
      }
      if (lastEnd < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      }
      parent.replaceChild(frag, node);
    }

    marksRef.current = hits;
    setMatchCount(hits.length);
    if (hits.length > 0) {
      setMatchIndex(0);
      hits[0].style.background = MARK_BG_ACTIVE;
      hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [containerRef, clearMarks, caseSensitive, regex]);

  // Navigate matches
  const goTo = useCallback((delta: number) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    // Reset current
    marks[matchIndex].style.background = MARK_BG;
    const next = (matchIndex + delta + marks.length) % marks.length;
    setMatchIndex(next);
    marks[next].style.background = MARK_BG_ACTIVE;
    marks[next].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [matchIndex]);

  const next = useCallback(() => goTo(1), [goTo]);
  const prev = useCallback(() => goTo(-1), [goTo]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    clearMarks();
  }, [clearMarks]);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  // Cmd+F / Ctrl+F handler; Alt+C / Alt+R toggle the match options
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen) {
          close();
        } else {
          open();
        }
      }
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        close();
      }
      if (isOpen && e.altKey && e.code === 'KeyC') {
        e.preventDefault();
        setCaseSensitive((v) => !v);
      }
      if (isOpen && e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        setRegex((v) => !v);
      }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, open, close]);

  // Re-highlight when query or match options change
  useEffect(() => {
    if (isOpen && query) {
      highlight(query);
    } else if (!query) {
      clearMarks();
    }
  }, [query, isOpen, highlight, clearMarks]);

  return {
    isOpen, query, setQuery, matchIndex, matchCount, next, prev, close,
    caseSensitive, setCaseSensitive, regex, setRegex, isInvalid,
  };
}

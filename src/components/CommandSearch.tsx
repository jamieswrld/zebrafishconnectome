'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { asLoreId, classifyIdentifier } from '@/core/ids';
import type { SearchResult } from '@/core/types';
import { toDataError, type DataError } from '@/core/errors';
import { useBrainStore } from '@/state/brainStore';

/**
 * Identifier search, opened with / or Cmd/Ctrl-K.
 *
 * Resolution order matters: a lore ID present in the loaded population is
 * matched locally and resolves instantly with no network round trip. Only terms
 * that are not in the local index go upstream, where a root ID can also be
 * resolved back to its stable lore ID.
 */
export function CommandSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<DataError | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const adapter = useBrainStore((s) => s.adapter);
  const index = useBrainStore((s) => s.index);
  const lookup = useBrainStore((s) => s.loreIdLookup);
  const selectIndex = useBrainStore((s) => s.selectIndex);
  const selectLoreId = useBrainStore((s) => s.selectLoreId);

  useEffect(() => {
    if (open) {
      setTerm('');
      setResults([]);
      setError(null);
      setActiveIndex(0);
      // Focus after paint so the field is ready for the next keystroke.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    // Debounced: a search should not fire a request per keystroke.
    const timer = setTimeout(() => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const local: SearchResult[] = [];
          if (index && lookup && /^\d+$/.test(trimmed)) {
            const exact = lookup.get(Number(trimmed));
            if (exact !== undefined) {
              local.push({
                datasetId: index.datasetId,
                loreId: asLoreId(index.loreIds[exact]),
                label: String(index.loreIds[exact]),
                sublabel: 'in loaded population',
                cellType: 'unknown',
                matchedOn: 'lore-id',
              });
            }
          }

          let remote: SearchResult[] = [];
          if (adapter?.search && local.length === 0) {
            remote = await adapter.search(trimmed, controller.signal);
          }
          if (controller.signal.aborted) return;
          setResults([...local, ...remote]);
          setActiveIndex(0);
        } catch (e) {
          if (!controller.signal.aborted) setError(toDataError(e));
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [term, open, adapter, index, lookup]);

  const choose = useCallback(
    (result: SearchResult) => {
      const localIndex = lookup?.get(Number(result.loreId));
      if (localIndex !== undefined) selectIndex(localIndex);
      else selectLoreId(result.loreId);
      onClose();
    },
    [lookup, selectIndex, selectLoreId, onClose],
  );

  if (!open) return null;

  const kind = classifyIdentifier(term);

  return (
    <div
      className="palette-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search neurons"
    >
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Lore ID or root ID…"
          aria-label="Neuron identifier"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter' && results[activeIndex]) {
              choose(results[activeIndex]);
            }
          }}
        />

        <ul className="palette__results">
          {results.map((r, i) => (
            <li key={`${r.datasetId}-${r.loreId}-${i}`}>
              <button
                className="palette__result"
                data-active={i === activeIndex}
                onClick={() => choose(r)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span>{r.label}</span>
                <span className="faint" style={{ marginLeft: 'auto', fontSize: 10.5 }}>
                  {r.sublabel ?? r.matchedOn}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="palette__hint">
          {busy
            ? 'Searching…'
            : error
              ? `${error.detail ?? error.message}`
              : term.trim().length === 0
                ? 'Enter a stable lore ID, or a 64-bit root ID to resolve it.'
                : results.length === 0
                  ? kind === 'unknown'
                    ? 'Not an identifier. Region and annotation search are not implemented yet.'
                    : `No ${kind === 'root' ? 'root' : 'lore'} ID matched.`
                  : `${results.length} result${results.length === 1 ? '' : 's'} · ↑↓ to move, ⏎ to select`}
        </div>
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Top navigation.
 *
 * BRAIN and DATA are real. SIMULATE, EXPERIMENTS and LAB are disabled with a
 * tooltip saying what each will be, rather than linking to a page that pretends
 * to be finished. An honest disabled control is worth more than a placeholder.
 */

interface NavEntry {
  id: string;
  label: string;
  href?: string;
  title: string;
}

const NAV: NavEntry[] = [
  { id: 'brain', label: 'Brain', href: '/brain', title: 'Whole-brain explorer.' },
  {
    id: 'organism',
    label: 'Organism',
    href: '/brain?view=organism',
    title: 'The same connectome, inside a reference larval body.',
  },
  {
    id: 'world',
    label: 'World',
    href: '/world',
    title: 'The organism swimming in a simulated tank.',
  },
  {
    id: 'simulate',
    label: 'Simulate',
    title:
      'Not implemented. Will run a connectome-driven network model, badged SIMULATED. Types exist in src/simulation.',
  },
  {
    id: 'experiments',
    label: 'Experiments',
    title:
      'Not implemented. Will host stimulus experiments such as the looming-threat escape response.',
  },
  { id: 'data', label: 'Data', href: '/data', title: 'Datasets, provenance and licensing.' },
  {
    id: 'lab',
    label: 'Lab',
    title: 'Not implemented. Will host advanced graph queries and technical tooling.',
  },
];

export function AppHeader({
  view,
  onSearch,
  onCopyLink,
  onToggleLeft,
  onToggleRight,
}: {
  /** Distinguishes BRAIN from ORGANISM, which share one route. */
  view?: 'brain' | 'organism';
  onSearch?: () => void;
  onCopyLink?: () => void;
  onToggleLeft?: () => void;
  onToggleRight?: () => void;
}) {
  const pathname = usePathname();

  const isCurrent = (entry: NavEntry): boolean => {
    if (!entry.href) return false;
    if (entry.id === 'brain') return pathname === '/brain' && view !== 'organism';
    if (entry.id === 'organism') return pathname === '/brain' && view === 'organism';
    return pathname === entry.href;
  };

  return (
    <header className="shell-header">
      <Link href="/" className="wordmark" style={{ borderBottom: 'none' }}>
        Connectome Lab
      </Link>

      <nav className="nav" aria-label="Sections">
        {NAV.map((entry) =>
          entry.href ? (
            <Link
              key={entry.id}
              href={entry.href}
              className="nav-item"
              title={entry.title}
              aria-current={isCurrent(entry) ? 'page' : undefined}
              style={{ borderBottomStyle: 'solid' }}
            >
              {entry.label}
            </Link>
          ) : (
            <button key={entry.id} className="nav-item" disabled title={entry.title}>
              {entry.label}
            </button>
          ),
        )}
      </nav>

      <div className="header-right">
        {onSearch ? (
          <button className="btn" onClick={onSearch} title="Search by identifier (/ or Ctrl-K)">
            Search
          </button>
        ) : null}
        {onCopyLink ? (
          <button className="btn" onClick={onCopyLink} title="Copy a link to this exact view">
            Copy link
          </button>
        ) : null}
        {onToggleLeft ? (
          <button className="btn" onClick={onToggleLeft} title="Toggle filters panel ([)">
            ⊣
          </button>
        ) : null}
        {onToggleRight ? (
          <button className="btn" onClick={onToggleRight} title="Toggle inspector panel (])">
            ⊢
          </button>
        ) : null}
      </div>
    </header>
  );
}

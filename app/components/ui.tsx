/**
 * The small server-rendered pieces every page reuses.
 *
 * All server components: none of them takes an event handler, so none of them
 * pulls React state — or `better-sqlite3` — into the browser bundle.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { LeadClassification } from '@/lib/db';
import {
  CLASSIFICATION_LABELS,
  STATUS_LABELS,
  formatNumber,
  formatPercent,
  scoreBand,
} from '../lib/format';

export function Score({ value }: { value: number }) {
  return (
    <span className={`score ${scoreBand(value)}`} title={`Lead score ${value}/100`}>
      {value}
    </span>
  );
}

export function ClassificationBadge({ value }: { value: LeadClassification }) {
  const tone =
    value === 'FACADE_CONTRACTOR'
      ? 'good'
      : value === 'CONSTRUCTION_MATERIAL_STORE'
        ? 'accent'
        : value === 'BOTH'
          ? 'warn'
          : '';
  return <span className={`badge ${tone}`}>{CLASSIFICATION_LABELS[value] ?? value}</span>;
}

export function StatusBadge({ value }: { value: string }) {
  const tone =
    value === 'approved'
      ? 'good'
      : value === 'rejected'
        ? 'bad'
        : value === 'reviewed'
          ? 'accent'
          : '';
  return <span className={`badge ${tone}`}>{STATUS_LABELS[value] ?? value}</span>;
}

/** A proportion, drawn. `title` carries the exact numbers for anyone who needs them. */
export function Bar({
  part,
  whole,
  tone = '',
}: {
  part: number;
  whole: number;
  tone?: '' | 'good' | 'warn' | 'bad';
}) {
  const pct = whole === 0 ? 0 : Math.min(100, (part / whole) * 100);
  return (
    <span
      className={`bar ${tone}`}
      title={`${formatNumber(part)} / ${formatNumber(whole)} (${formatPercent(part, whole)})`}
      role="img"
      aria-label={`${formatPercent(part, whole)}`}
    >
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note == null ? null : <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Panel({
  title,
  right,
  children,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {title == null && right == null ? null : (
        <div className="page-head" style={{ marginBottom: 10 }}>
          {title == null ? <span /> : <h2>{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * A source URL.
 *
 * Rendered as a link only when it resolves to a page. The Overture extract's
 * `source_url` is an S3 object prefix — correct provenance, dead link — and
 * dressing it up as an anchor promises the reviewer something that is not
 * there. FUZZ-33 is fixing the ingest side.
 */
export function SourceUrl({
  url,
  browsable,
  label,
}: {
  url: string;
  browsable: boolean;
  label: string;
}) {
  if (browsable) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
        {label}
      </a>
    );
  }
  return (
    <span className="muted" title={`${url}\n\nNot a browsable page — a dataset object reference.`}>
      {label} <span className="badge">nije link</span>
    </span>
  );
}

export function Pager({
  page,
  pageCount,
  total,
  href,
  unit = 'leadova',
}: {
  page: number;
  pageCount: number;
  total: number;
  href: (page: number) => string;
  unit?: string;
}) {
  const window = 2;
  const pages: number[] = [];
  for (let i = Math.max(1, page - window); i <= Math.min(pageCount, page + window); i += 1) {
    pages.push(i);
  }

  return (
    <div className="pager">
      <span className="small muted">
        {formatNumber(total)} {unit} · strana {page} od {pageCount}
      </span>
      <span className="links">
        {page > 1 ? (
          <Link className="button" href={href(page - 1)}>
            ‹ prethodna
          </Link>
        ) : (
          <button disabled>‹ prethodna</button>
        )}
        {pages[0] !== 1 ? (
          <>
            <Link className="button" href={href(1)}>
              1
            </Link>
            <span className="muted">…</span>
          </>
        ) : null}
        {pages.map((entry) =>
          entry === page ? (
            <button key={entry} className="primary" disabled>
              {entry}
            </button>
          ) : (
            <Link key={entry} className="button" href={href(entry)}>
              {entry}
            </Link>
          ),
        )}
        {pages[pages.length - 1] !== pageCount ? (
          <>
            <span className="muted">…</span>
            <Link className="button" href={href(pageCount)}>
              {pageCount}
            </Link>
          </>
        ) : null}
        {page < pageCount ? (
          <Link className="button" href={href(page + 1)}>
            sledeća ›
          </Link>
        ) : (
          <button disabled>sledeća ›</button>
        )}
      </span>
    </div>
  );
}

/**
 * The lead list.
 *
 * Search, filter, sort and pagination all happen in SQL — `listLeads()` returns
 * one page and the size of the whole result set, and this file renders it. The
 * filter form is a plain GET form, so the state of the list is its URL: a
 * filtered view is bookmarkable, shareable, and survives a reload, and none of
 * it needs a line of client JavaScript.
 */
import Link from 'next/link';
import { leadFacets, listLeads, type LeadSortKey } from '@/lib/review';
import { db, EXPORT_AVAILABLE, EXPORT_ISSUE } from '../lib/db';
import {
  CLASSIFICATION_LABELS,
  STATUS_LABELS,
  formatDate,
  formatNumber,
  formatPhone,
} from '../lib/format';
import {
  leadHref,
  leadQueryToSearch,
  parseLeadQuery,
  type RawSearchParams,
} from '../lib/search-params';
import { ClassificationBadge, Empty, Pager, Score, StatusBadge } from '../components/ui';

const COLUMNS: ReadonlyArray<{ key: LeadSortKey | null; label: string; num?: boolean }> = [
  { key: 'name', label: 'Naziv' },
  { key: null, label: 'Telefon' },
  { key: 'city', label: 'Grad' },
  { key: null, label: 'Opština' },
  { key: null, label: 'Tip' },
  { key: null, label: 'Delatnost (APR)' },
  { key: 'score', label: 'Skor', num: true },
  { key: null, label: 'Izvori', num: true },
  { key: null, label: 'Kanali' },
  { key: null, label: 'Status' },
  { key: 'lastSeen', label: 'Poslednji put', num: true },
];

export default async function LeadListPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const query = parseLeadQuery(params);
  const handle = db();
  const page = listLeads(handle, query);
  const facets = leadFacets(handle);

  const selectedTypes = new Set(query.classifications ?? []);
  const sortHref = (key: LeadSortKey) =>
    leadHref(query, {
      sort: key,
      direction: query.sort === key && query.direction !== 'asc' ? 'asc' : 'desc',
    });
  const sortMark = (key: LeadSortKey) =>
    query.sort !== key && !(key === 'score' && query.sort == null)
      ? ''
      : (query.direction ?? 'desc') === 'asc'
        ? ' ↑'
        : ' ↓';

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Leadovi</h1>
          <p className="subtitle">
            {formatNumber(page.total)} rezultata od ukupno{' '}
            {formatNumber(facets.classifications.reduce((sum, f) => sum + f.count, 0))} ·
            filtriranje, sortiranje i straničenje se izvršavaju u bazi
          </p>
        </div>
        <div className="actions">
          <button disabled={!EXPORT_AVAILABLE} title={`XLSX izvoz stiže sa ${EXPORT_ISSUE}`}>
            {EXPORT_AVAILABLE ? 'Izvezi izbor u XLSX' : `Izvoz XLSX — čeka ${EXPORT_ISSUE}`}
          </button>
        </div>
      </div>

      <form className="filters" action="/leads" method="get">
        <div className="field">
          <label htmlFor="q">Pretraga (naziv, grad, adresa, telefon)</label>
          <input
            type="search"
            id="q"
            name="q"
            defaultValue={query.search ?? ''}
            placeholder="npr. fasade, Čačak, 064/123-4567"
          />
        </div>

        <div className="field">
          <label htmlFor="opstina">Opština</label>
          <select id="opstina" name="opstina" defaultValue={query.municipalityId ?? ''}>
            <option value="">sve ({facets.municipalities.length})</option>
            {facets.municipalities.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.label} ({facet.count})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="izvor">Izvor</label>
          <select id="izvor" name="izvor" defaultValue={query.sourceId ?? ''}>
            <option value="">svi</option>
            {facets.sources.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.label} ({facet.count})
              </option>
            ))}
          </select>
        </div>

        {/* Only offered once a register-derived source has actually filed a
            code. An empty select is a filter that promises something the data
            cannot answer. */}
        {facets.activityCodes.length === 0 ? null : (
          <div className="field">
            <label htmlFor="delatnost">Šifra delatnosti (APR)</label>
            <select id="delatnost" name="delatnost" defaultValue={query.activityCode ?? ''}>
              <option value="">sve ({facets.activityCodes.length})</option>
              {facets.activityCodes.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {facet.label} ({facet.count})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="phone">Telefon</label>
          <select
            id="phone"
            name="phone"
            defaultValue={query.hasPhone === true ? 'yes' : query.hasPhone === false ? 'no' : ''}
          >
            <option value="">svejedno</option>
            <option value="yes">ima telefon</option>
            <option value="no">bez telefona</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="minScore">Min. skor</label>
          <input
            type="number"
            id="minScore"
            name="minScore"
            min={0}
            max={100}
            step={5}
            style={{ width: 90, minWidth: 0 }}
            defaultValue={query.minScore ?? ''}
          />
        </div>

        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={query.status ?? ''}>
            <option value="">svi</option>
            {facets.statuses.map((facet) => (
              <option key={facet.value} value={facet.value}>
                {STATUS_LABELS[facet.value] ?? facet.value} ({facet.count})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Tip (oznake iz baze)</label>
          <div className="chips">
            {/* Rendered from the labels present in the data. FUZZ-32 will move
                this distribution, and a hard-coded list would go stale. */}
            {facets.classifications.map((facet) => (
              <label
                key={facet.value}
                className="chip"
                aria-current={selectedTypes.has(facet.value as never)}
              >
                <input
                  type="checkbox"
                  name="type"
                  value={facet.value}
                  defaultChecked={selectedTypes.has(facet.value as never)}
                />
                {CLASSIFICATION_LABELS[facet.value as keyof typeof CLASSIFICATION_LABELS] ??
                  facet.value}
                <span className="count">{formatNumber(facet.count)}</span>
              </label>
            ))}
          </div>
        </div>

        <input type="hidden" name="sort" value={query.sort ?? 'score'} />
        <input type="hidden" name="dir" value={query.direction ?? 'desc'} />
        <input type="hidden" name="perPage" value={query.pageSize ?? 50} />

        <div className="actions">
          <button type="submit" className="primary">
            Primeni
          </button>
          <Link className="button" href="/leads">
            Poništi
          </Link>
        </div>
      </form>

      {page.total === 0 ? (
        <div className="table-wrap">
          <Empty>
            Nema leadova za ovaj filter. <Link href="/leads">Poništi filter</Link> i pokušaj ponovo.
          </Empty>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column.label} className={column.num ? 'num' : undefined}>
                      {column.key == null ? (
                        column.label
                      ) : (
                        <Link href={sortHref(column.key)}>
                          {column.label}
                          {sortMark(column.key)}
                        </Link>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/leads/${row.id}`}>{row.name}</Link>
                    </td>
                    <td className="mono nowrap">
                      {row.primaryPhone == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          {formatPhone(row.primaryPhone, row.primaryPhoneNational)}
                          {row.phoneCount > 1 ? (
                            <span className="muted small"> +{row.phoneCount - 1}</span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>{row.cityRaw ?? <span className="muted">—</span>}</td>
                    <td className="muted small mono">{row.municipalityId ?? '—'}</td>
                    <td>
                      <ClassificationBadge value={row.classification} />
                    </td>
                    <td className="small">
                      {row.activityCode == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <Link
                          href={leadHref(query, { activityCode: row.activityCode })}
                          title={`Šifra delatnosti ${row.activityCode}`}
                        >
                          {row.activityName ?? row.activityCode}
                        </Link>
                      )}
                    </td>
                    <td className="num">
                      <Score value={row.leadScore} />
                    </td>
                    <td className="num">{row.sourceCount}</td>
                    <td className="small nowrap">
                      {row.hasWebsite ? <span className="badge">sajt</span> : null}{' '}
                      {row.hasEmail ? <span className="badge">e-pošta</span> : null}
                      {!row.hasWebsite && !row.hasEmail ? <span className="muted">—</span> : null}
                    </td>
                    <td>
                      <StatusBadge value={row.status} />
                    </td>
                    <td className="num muted small nowrap">{formatDate(row.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page.page}
            pageCount={page.pageCount}
            total={page.total}
            href={(next) => `/leads${leadQueryToSearch(query, { page: next })}`}
          />
        </>
      )}
    </main>
  );
}

export const dynamic = 'force-dynamic';

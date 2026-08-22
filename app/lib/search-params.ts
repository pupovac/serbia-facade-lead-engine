/**
 * The lead list's URL is its state.
 *
 * Filters, sort and page live in the query string, not in React state: the
 * whole list is rendered on the server, so a filter change is a navigation, and
 * a filtered view is a link a salesperson can bookmark or paste to a colleague.
 * This module is the one place that translates between the two.
 */
import {
  DEFAULT_PAGE_SIZE,
  LEAD_SORT_KEYS,
  type LeadListQuery,
  type LeadSortKey,
  type SortDirection,
} from '@/lib/review';
import {
  LEAD_CLASSIFICATIONS,
  LEAD_STATUSES,
  type LeadClassification,
  type LeadStatus,
} from '@/lib/db';

/** What Next hands a server component: a value, a repeated value, or nothing. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function one(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];
  const found = Array.isArray(value) ? value[0] : value;
  return found === '' ? undefined : found;
}

function many(params: RawSearchParams, key: string): string[] {
  const value = params[key];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry.split(',').filter((part) => part !== ''),
  );
}

function integer(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a query string into a list query.
 *
 * Every value is validated against the vocabulary the database actually uses —
 * a hand-edited URL cannot smuggle a filter value past the query builder.
 */
export function parseLeadQuery(params: RawSearchParams): LeadListQuery {
  const sortParam = one(params, 'sort');
  const sort = LEAD_SORT_KEYS.includes(sortParam as LeadSortKey)
    ? (sortParam as LeadSortKey)
    : undefined;
  const dirParam = one(params, 'dir');
  const direction: SortDirection | undefined =
    dirParam === 'asc' || dirParam === 'desc' ? dirParam : undefined;

  const classifications = many(params, 'type').filter((value): value is LeadClassification =>
    (LEAD_CLASSIFICATIONS as readonly string[]).includes(value),
  );
  const statusParam = one(params, 'status');
  const status = (LEAD_STATUSES as readonly string[]).includes(statusParam ?? '')
    ? (statusParam as LeadStatus)
    : undefined;

  const phone = one(params, 'phone');

  return {
    search: one(params, 'q'),
    municipalityId: one(params, 'opstina'),
    cityId: one(params, 'grad'),
    classifications: classifications.length > 0 ? classifications : undefined,
    status,
    minScore: integer(one(params, 'minScore')),
    minRelevance: integer(one(params, 'minRelevance')),
    minContactability: integer(one(params, 'minContactability')),
    // Ruled-out leads are off by default. `?type=OUT_OF_SCOPE` turns them on
    // implicitly; `?ruledOut=yes` is for auditing the exclusions across labels.
    includeOutOfScope: one(params, 'ruledOut') === 'yes' ? true : undefined,
    hasPhone: phone === 'yes' ? true : phone === 'no' ? false : undefined,
    sourceId: one(params, 'izvor'),
    // `delatnost` — the APR activity code, in Serbian like every other filter
    // key. Validated against the facet, not against a baked-in code list: the
    // vocabulary is whatever the crawls filed.
    activityCode: one(params, 'delatnost'),
    sort,
    direction,
    page: integer(one(params, 'page')),
    pageSize: integer(one(params, 'perPage')) ?? DEFAULT_PAGE_SIZE,
  };
}

/** Render a list query back into a query string, dropping everything default. */
export function leadQueryToSearch(
  query: LeadListQuery,
  overrides: Partial<LeadListQuery> = {},
): string {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined | null) => {
    if (value == null || value === '') return;
    params.set(key, String(value));
  };

  set('q', merged.search);
  set('opstina', merged.municipalityId);
  set('grad', merged.cityId);
  if (merged.classifications && merged.classifications.length > 0) {
    params.set('type', merged.classifications.join(','));
  }
  set('status', merged.status);
  if (merged.minScore != null && merged.minScore > 0) set('minScore', merged.minScore);
  if (merged.minRelevance != null && merged.minRelevance > 0) {
    set('minRelevance', merged.minRelevance);
  }
  if (merged.minContactability != null && merged.minContactability > 0) {
    set('minContactability', merged.minContactability);
  }
  if (merged.includeOutOfScope === true) params.set('ruledOut', 'yes');
  if (merged.hasPhone === true) params.set('phone', 'yes');
  if (merged.hasPhone === false) params.set('phone', 'no');
  set('izvor', merged.sourceId);
  set('delatnost', merged.activityCode);
  if (merged.sort && merged.sort !== 'score') set('sort', merged.sort);
  if (merged.direction && merged.direction !== 'desc') set('dir', merged.direction);
  if (merged.page != null && merged.page > 1) set('page', merged.page);
  if (merged.pageSize != null && merged.pageSize !== DEFAULT_PAGE_SIZE) {
    set('perPage', merged.pageSize);
  }

  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/** A link to the list with one thing changed and the page reset. */
export function leadHref(query: LeadListQuery, overrides: Partial<LeadListQuery>): string {
  return `/leads${leadQueryToSearch(query, { page: 1, ...overrides })}`;
}

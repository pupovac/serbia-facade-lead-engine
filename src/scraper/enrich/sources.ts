/**
 * The two pseudo-sources enrichment writes under.
 *
 * `sources.id` is a foreign key from `lead_sources`, `lead_phones`,
 * `lead_contacts` and `lead_field_values`, so every claim in the database names
 * who made it. Enrichment makes claims, so it needs rows — and it needs *two*
 * rather than one, because the two paths are not equally trustworthy and a
 * reader of the provenance has to be able to tell them apart without opening
 * the evidence JSON.
 *
 * They are genuinely independent sources, not bookkeeping: a phone read off a
 * business's own website is a second, independent publication of that number,
 * and `lead_score`'s corroboration component is right to count it. What it must
 * not do is count the *same* page twice, which is why `lead_sources` is keyed
 * on (lead, source, URL) and a re-run updates rather than inserts.
 */
import { getSource, upsertSource, type Db } from '@/lib/db';

/** Pages on a domain the lead already carries. The high-confidence path. */
export const OWN_SITE_SOURCE = 'website-enrichment';

/** Pages a search turned up for a lead with no website. The path that needs the gate. */
export const SEARCH_SOURCE = 'search-enrichment';

export const ENRICHMENT_SOURCE_IDS = [OWN_SITE_SOURCE, SEARCH_SOURCE] as const;

/**
 * The `crawl_state.scope_key` one lead's enrichment is recorded under.
 *
 * A crawl scope for an adapter is a listing page; for enrichment it is a lead,
 * because that is the unit a run resumes at. It is deliberately *not*
 * `lead_sources`: a lead the crawler visited and found nothing on has no
 * `lead_sources` row, so keying incrementality on that table would re-crawl
 * every fruitless site on every run — the exact sites least worth a request.
 */
export function leadScopeKey(leadId: number): string {
  return `lead:${leadId}`;
}

const ROWS = {
  [OWN_SITE_SOURCE]: {
    name: 'Website contact-page enrichment',
    url: 'https://github.com/pupovac/serbia-facade-lead-engine',
    category: 'enrichment (own site)',
    notes:
      'Contact-bearing pages on a domain the lead already carries. Trusted by ownership: ' +
      'the business publishes the page, so what is on it is theirs.',
  },
  [SEARCH_SOURCE]: {
    name: 'Search-discovered contact enrichment',
    url: 'https://github.com/pupovac/serbia-facade-lead-engine',
    category: 'enrichment (discovered)',
    notes:
      'Pages found by searching for a lead with no website. Nothing is merged from here ' +
      'without corroboration — see src/scraper/enrich/confidence.ts.',
  },
} as const;

/**
 * Make sure both rows exist. Idempotent, and it never overwrites a row a human
 * or the registry seed has since edited.
 */
export function ensureEnrichmentSources(db: Db, now: Date = new Date()): void {
  for (const id of ENRICHMENT_SOURCE_IDS) {
    if (getSource(db, id) !== undefined) continue;
    const row = ROWS[id];
    upsertSource(db, {
      id,
      name: row.name,
      url: row.url,
      category: row.category,
      priority: 'high',
      hasContractors: true,
      hasStores: true,
      requiresJs: false,
      enabled: true,
      notes: row.notes,
      createdAt: now,
      updatedAt: now,
    });
  }
}

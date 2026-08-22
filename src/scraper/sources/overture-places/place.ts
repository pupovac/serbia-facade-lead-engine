/**
 * One cached Overture row → one `RawLead`.
 *
 * Pure, and deliberately dependency-free: the fixture test runs this over a
 * saved slice of a real extract, so parsing is verifiable without DuckDB, S3 or
 * a network. Nothing here canonicalizes a phone, resolves a city or decides a
 * lead's type — `src/lib` owns all three and `src/scraper/pipeline.ts` calls
 * them.
 */
import { z } from 'zod';
import type { RawLeadInput, ScrapedLink } from '../../types.js';
import { placeUrl } from './dataset.js';
import { armFor, type QueryArm } from './query.js';

/**
 * The shape the extract writes, validated on the way back in.
 *
 * The cache is a file this adapter wrote, so this is not defensive
 * programming — it is the assertion that a cache written by an older release,
 * an older query or a half-finished run cannot be silently read as if it were
 * current. A row that fails here is a structural failure, not a bad record.
 */
export const placeRowSchema = z.object({
  /** GERS id — stable across releases, and the item's identity for resume. */
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1).nullable(),
  alternate_categories: z.array(z.string()).nullable().default(null),
  confidence: z.number().nullable().default(null),
  operating_status: z.string().nullable().default(null),
  phones: z.array(z.string()).nullable().default(null),
  websites: z.array(z.string()).nullable().default(null),
  emails: z.array(z.string()).nullable().default(null),
  socials: z.array(z.string()).nullable().default(null),
  address: z.string().nullable().default(null),
  locality: z.string().nullable().default(null),
  postcode: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  longitude: z.number().nullable().default(null),
  latitude: z.number().nullable().default(null),
  /** `meta`, `Microsoft`, `Foursquare`, … — who contributed the record. */
  datasets: z.array(z.string()).nullable().default(null),
});

export type PlaceRow = z.infer<typeof placeRowSchema>;

const list = (value: readonly string[] | null): string[] =>
  (value ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);

/**
 * Overture writes `""` where a field is absent as often as it writes `null` —
 * `postcode` on a site office, `region` on nearly everything. The `RawLead`
 * boundary requires a non-empty string or nothing, and an empty string is
 * nothing, so it is turned into one here rather than rejected as a bad record.
 */
const blank = (value: string | null): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * A record with a website but no phone is still worth having — it is one crawl
 * away from being the deliverable. It is emitted with this flag so the
 * enrichment crawler can select it out of `raw_records` instead of re-deriving
 * the condition.
 */
export interface EnrichmentMark {
  readonly needed: true;
  readonly reason: 'website_without_phone';
  readonly website: string;
}

export function enrichmentMark(row: PlaceRow): EnrichmentMark | null {
  const websites = list(row.websites);
  const first = websites[0];
  if (list(row.phones).length > 0 || first === undefined) return null;
  return { needed: true, reason: 'website_without_phone', website: first };
}

/**
 * `text` and `links` are filled in even though every field above is modelled,
 * for the reason `docs/writing-an-adapter.md` gives: they are what lets the
 * shared extractors find the address nobody anticipated and the Facebook page
 * nobody modelled. Here they are the record's own values and nothing else —
 * this is a dataset row, not a page, so there is no footer to leak.
 */
function evidenceText(row: PlaceRow): string {
  return [
    row.name,
    row.category,
    ...list(row.alternate_categories),
    row.address,
    row.locality,
    row.postcode,
    ...list(row.phones),
    ...list(row.emails),
    ...list(row.websites),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');
}

function evidenceLinks(row: PlaceRow): ScrapedLink[] {
  return [
    ...list(row.websites).map((href) => ({ href, text: 'website' })),
    ...list(row.socials).map((href) => ({ href, text: 'social' })),
    ...list(row.emails).map((href) => ({ href: `mailto:${href}`, text: 'email' })),
  ];
}

export interface ToRawLeadOptions {
  readonly release: string;
  /** The scope this record was discovered under, kept for coverage auditing. */
  readonly scopeKey: string;
  /** The municipality the record was filed under, or `null` when none resolved. */
  readonly municipalityId: string | null;
  readonly cityId: string | null;
}

/**
 * The mapping. Every string goes out exactly as Overture published it —
 * including the `+381…` phones, which are already E.164 in 98% of cases and are
 * still handed over raw, because `src/lib/phone` is what decides what a phone
 * number is.
 */
export function toRawLead(row: PlaceRow, options: ToRawLeadOptions): RawLeadInput {
  const arm: QueryArm = armFor(row.category);
  const mark = enrichmentMark(row);
  const categories = [row.category, ...list(row.alternate_categories)].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return {
    sourceUrl: placeUrl(
      row.id,
      row.latitude === null || row.longitude === null
        ? undefined
        : { latitude: row.latitude, longitude: row.longitude },
    ),
    name: row.name,
    phones: list(row.phones),
    emails: list(row.emails),
    website: list(row.websites)[0] ?? null,
    socials: list(row.socials),
    city: blank(row.locality),
    address: blank(row.address),
    postalCode: blank(row.postcode),
    latitude: row.latitude,
    longitude: row.longitude,
    categories,
    text: evidenceText(row),
    links: evidenceLinks(row),
    extra: {
      gersId: row.id,
      release: options.release,
      queryArm: arm,
      /** Overture's source-agreement score, not a relevance score. See `query.ts`. */
      confidence: row.confidence,
      datasets: list(row.datasets),
      region: blank(row.region),
      discoveryScope: options.scopeKey,
      /** What discovery filed this record under, so coverage can be audited per record. */
      municipalityId: options.municipalityId,
      cityId: options.cityId,
      ...(mark === null ? {} : { enrichment: mark }),
    },
  };
}

/**
 * What "a facade contractor or a building-supply store in Serbia" is, expressed
 * as one SQL statement against the Overture places theme.
 *
 * Two arms, and the shape of them is measured rather than assumed (the counts
 * are in `README.md`):
 *
 * - **Category** — `taxonomy.primary` in the 16 categories FUZZ-8 identified.
 * - **Name** — a Serbian-term regex over `names.primary`, because 70 real
 *   businesses (`Stovariste Bihorac`, `Euro Okov građevinski materijal`,
 *   `Hidroizolacija Miljković`) are filed under `shopping`, `retail` or
 *   `professional_service` and category filtering alone loses every one of them.
 *
 * Two arms that were tried and rejected, so nobody re-adds them: matching
 * `taxonomy.hierarchy` instead of `taxonomy.primary` pulls in 1,805 furniture
 * and lighting stores that merely share an ancestor node, and the Cyrillic
 * spelling of the same regex adds 3 records, all of them schools — Overture's
 * Serbian business names are written in Latin.
 */

/** Contractor-side `taxonomy.primary` values. */
export const CONTRACTOR_CATEGORIES = [
  'building_or_construction_service',
  'contractor',
  'building_contractor',
  'carpenter',
  'painting',
  'roofing',
  'masonry_concrete',
  'paving_contractor',
  'flooring_contractor',
  'stone_and_masonry',
] as const;

/** Store-side `taxonomy.primary` values. */
export const STORE_CATEGORIES = [
  'hardware_store',
  'building_supply_store',
  'home_improvement_store',
  'hardware_home_and_garden_store',
  'lumber_store',
  'paint_store',
] as const;

export const TARGET_CATEGORIES: readonly string[] = [...CONTRACTOR_CATEGORIES, ...STORE_CATEGORIES];

/**
 * Serbian trade terms, lower-cased, in both spellings the project brief
 * requires: `gra[dđ]evin` covers `građevinski`, `gradjevinski` is spelled out
 * because the `dj` digraph is not a diacritic fold, and `stovari[sš]t` covers
 * `stovarište` / `stovariste`. RE2 on the DuckDB side, `RegExp` on ours — the
 * subset used here means the same thing to both.
 */
export const NAME_PATTERN =
  'fasad|termoizolac|izolacij|stiropor|stovari[sš]t|gra[dđ]evin|gradjevin|demit|moler|malter';

/** The same pattern, for deciding after the fact which arm found a record. */
export const nameRegExp = new RegExp(NAME_PATTERN, 'u');

/**
 * Serbia's bounding box, from FUZZ-8.
 *
 * It is not a nicety: `bbox` carries parquet row-group statistics, so this
 * predicate is what lets DuckDB skip almost every row group in 10.4 GB of
 * global places and read ~15 MB. `addresses[1].country` is the actual
 * correctness filter — the box overlaps six neighbours.
 */
export const SERBIA_BBOX = { xmin: 18.8, xmax: 23.1, ymin: 42.2, ymax: 46.3 } as const;

/** Which arm of the query found a record. Not a lead classification — that is `src/lib/classify`. */
export type QueryArm = 'contractor-category' | 'store-category' | 'name-match';

export function armFor(category: string | null): QueryArm {
  if (category !== null && (CONTRACTOR_CATEGORIES as readonly string[]).includes(category)) {
    return 'contractor-category';
  }
  if (category !== null && (STORE_CATEGORIES as readonly string[]).includes(category)) {
    return 'store-category';
  }
  return 'name-match';
}

/** Every arm, in the order scopes are walked. */
export const QUERY_ARMS: readonly QueryArm[] = [
  'contractor-category',
  'store-category',
  'name-match',
];

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The columns the extract depends on, checked against the release before the
 * scan runs. Overture moved `categories.primary` to `taxonomy.primary` in
 * December 2025; the next such move must fail loudly on the first request
 * rather than return a healthy zero.
 */
export const REQUIRED_COLUMNS: readonly string[] = [
  'id',
  'names',
  'taxonomy',
  'confidence',
  'phones',
  'websites',
  'emails',
  'socials',
  'addresses',
  'bbox',
  'sources',
  'operating_status',
];

/** `read_parquet([...])` over the pinned release's parts. */
export function sourceExpression(partUrls: readonly string[]): string {
  return `read_parquet([${partUrls.map(quote).join(', ')}])`;
}

/** The one-row probe that proves the schema before the scan pays for itself. */
export function describeSql(partUrls: readonly string[]): string {
  return `DESCRIBE SELECT * FROM ${sourceExpression(partUrls)} LIMIT 1`;
}

/**
 * The extract.
 *
 * `bbox.xmin`/`bbox.xmax` are the point's own coordinates — a place's geometry
 * is a point, so its box is degenerate — which is how the longitude and
 * latitude come out without loading the `spatial` extension.
 *
 * There is no `confidence` filter, and that is a deliberate departure from the
 * FUZZ-8 implementation note. Measured on this release, `confidence >= 0.3`
 * would drop 379 phone-bearing records — 23% of the whole phone yield — and the
 * ones it drops are businesses like `Pejos Gradnja doo` and
 * `Integral Build Farbara i Stovarište`. Overture's confidence measures source
 * agreement, not relevance, and this project does not discard a phone number
 * over it. The value is emitted on every record so scoring and review can weigh
 * it.
 */
export function extractSql(partUrls: readonly string[]): string {
  const categories = TARGET_CATEGORIES.map(quote).join(', ');
  return `SELECT
  id,
  names.primary AS name,
  taxonomy.primary AS category,
  taxonomy.alternates AS alternate_categories,
  confidence,
  operating_status,
  phones,
  websites,
  emails,
  socials,
  addresses[1].freeform AS address,
  addresses[1].locality AS locality,
  addresses[1].postcode AS postcode,
  addresses[1].region AS region,
  (bbox.xmin + bbox.xmax) / 2 AS longitude,
  (bbox.ymin + bbox.ymax) / 2 AS latitude,
  list_transform(sources, s -> s.dataset) AS datasets
FROM ${sourceExpression(partUrls)}
WHERE bbox.xmin BETWEEN ${SERBIA_BBOX.xmin} AND ${SERBIA_BBOX.xmax}
  AND bbox.ymin BETWEEN ${SERBIA_BBOX.ymin} AND ${SERBIA_BBOX.ymax}
  AND addresses[1].country = 'RS'
  AND (operating_status IS NULL OR operating_status <> 'closed')
  AND names.primary IS NOT NULL
  AND (
    taxonomy.primary IN (${categories})
    OR regexp_matches(lower(names.primary), ${quote(NAME_PATTERN)})
  )
ORDER BY id`;
}

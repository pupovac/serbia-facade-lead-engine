/**
 * `overture-places` — geographic discovery for the whole country.
 *
 * FUZZ-8 evaluated the free local-business mechanisms and recommended this one:
 * the Overture Maps places theme, queried straight off public object storage.
 * It is not what the issue expected — the expectation was OpenStreetMap via
 * Overpass — and the reasons it is not are measured, not stylistic. FUZZ-8
 * counted 794 stores and 72 contractors in OSM for the entire country, 43% of
 * them with a phone, against 1,700-odd Serbian records here at 95%; and
 * `overpass-api.de/robots.txt` says `Disallow: /api/`, which this project's
 * framework obeys with no override and no adapter-side opt-out. Both of those
 * are in `README.md` with the quotes.
 *
 * The shape is unusual for an adapter and worth understanding before editing:
 *
 * - **`discover` makes one request through `ctx.http`** — the S3 listing that
 *   proves the pinned release exists and enumerates its parquet parts — and then
 *   one DuckDB scan, cached to disk. Everything after that is local.
 * - **Scopes are `municipality × query arm`**, walked over all 145 local
 *   self-government units, empty ones included, because "which municipalities
 *   did this reach" is the question the issue asks and it cannot be answered by
 *   a walk that skips the silent ones.
 * - **`extract` fetches nothing.** The row is already in the item's hints, which
 *   is the case `docs/writing-an-adapter.md` describes as a source that
 *   publishes everything on the listing page.
 */
import { RobotsDisallowedError, StructureChangedError } from '../../errors.js';
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import {
  BUCKET_URL,
  isTruncated,
  listUrl,
  parseKeys,
  partUrl,
  placesPrefix,
  placeUrl,
  RELEASE,
} from './dataset.js';
import { placeRowSchema, toRawLead, type PlaceRow } from './place.js';
import { planScopes, summarize, yieldOf, UNASSIGNED } from './coverage.js';
import { loadExtract } from './warehouse.js';

/** How often the cursor is written inside one scope. */
const CURSOR_EVERY = 25;

/**
 * Validate the cache against the schema the parser expects.
 *
 * A row that fails is not a bad listing — it is this adapter's own extract
 * disagreeing with its own parser, which only happens when the release changed
 * shape underneath a stale cache. That is a structural failure and it ends the
 * run.
 */
function parseRows(rows: readonly unknown[], sourceId: string, url: string): PlaceRow[] {
  const parsed: PlaceRow[] = [];
  for (const row of rows) {
    const result = placeRowSchema.safeParse(row);
    if (!result.success) {
      throw new StructureChangedError({
        sourceId,
        url,
        selector: 'places.ndjson row',
        expected: `a row matching placeRowSchema (${result.error.issues[0]?.message ?? 'invalid'})`,
      });
    }
    parsed.push(result.data);
  }
  return parsed;
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const release = RELEASE;
  const index = listUrl(release);

  // The bucket publishes no robots.txt (404 — allow-all, per the framework's
  // own rule). Asking anyway is what makes that a checked fact rather than an
  // assumption, and it is the verdict the parquet reads inherit.
  const verdict = await ctx.http.robotsVerdict(
    partUrl(`${placesPrefix(release)}part-00000.parquet`),
  );
  if (!verdict.allowed) throw new RobotsDisallowedError(BUCKET_URL, verdict.rule);
  ctx.log.info('bucket robots verdict', { rule: verdict.rule, url: BUCKET_URL });

  const listing = await ctx.http.text(index);
  const keys = parseKeys(listing.body);
  ctx.expect(
    keys,
    '<Key>…</Key> in ListObjectsV2',
    index,
    `parquet parts under ${placesPrefix(release)}`,
  );
  if (isTruncated(listing.body)) {
    // A truncated listing means an incomplete scan, which would look exactly
    // like a smaller Serbia. It has to break the run, not shrink the numbers.
    ctx.expect(null, '<IsTruncated>false</IsTruncated>', index, 'the whole part list in one page');
  }
  ctx.log.info('release located', { release, parts: keys.length });

  const extract = await loadExtract({
    release,
    keys,
    log: ctx.log,
    userAgent: ctx.config.userAgent,
  });
  const rows = parseRows(extract.rows, ctx.sourceId, index);
  ctx.expect(rows, 'Overture places extract', index, 'one or more Serbian places');

  const plan = planScopes(rows, ctx.scope.municipalities);
  const coverage = summarize(plan);
  ctx.log.info('national extract ready', {
    release,
    cached: extract.cached,
    ...coverage,
  });

  for (const entry of plan) {
    const resume = ctx.state.resume(entry.scopeKey, ctx.scope, ctx.now());
    if (resume.skip) continue;

    let offset = 0;
    if (resume.cursor !== null) {
      const saved = Number.parseInt(resume.cursor, 10);
      if (Number.isFinite(saved) && saved > 0) offset = Math.min(saved, entry.rows.length);
    }

    for (let i = offset; i < entry.rows.length; i += 1) {
      const assigned = entry.rows[i];
      if (assigned === undefined) continue;
      yield {
        url: placeUrl(
          assigned.row.id,
          assigned.row.latitude === null || assigned.row.longitude === null
            ? undefined
            : { latitude: assigned.row.latitude, longitude: assigned.row.longitude },
        ),
        scopeKey: entry.scopeKey,
        label: assigned.row.name,
        hints: { row: assigned.row, assignment: assigned.assignment, release },
      };
      if ((i + 1) % CURSOR_EVERY === 0) {
        ctx.state.saveScope(entry.scopeKey, {
          cursor: String(i + 1),
          status: 'in_progress',
          at: ctx.now(),
        });
      }
    }

    // The scope's own yield, written where a later run — or a coverage report —
    // can read it back per municipality. This is the record of which parts of
    // the country this mechanism actually reaches, zero-yield units included.
    ctx.state.saveScope(entry.scopeKey, {
      cursor: JSON.stringify(yieldOf(entry, entry.rows.length)),
      status: 'done',
      at: ctx.now(),
    });
  }

  ctx.log.info('geographic sweep complete', {
    scopes: plan.length,
    unitsCovered: `${coverage.unitsCovered}/${coverage.unitsTotal}`,
    unassigned: coverage.unassigned,
  });
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const hints = ctx.expect(
    item.hints,
    'discovered item hints',
    item.url,
    'the Overture row discovery attached',
  ) as {
    row: unknown;
    assignment: { municipalityId: string; cityId: string | null };
    release: string;
  };

  const row = placeRowSchema.parse(hints.row);
  const municipalityId =
    hints.assignment.municipalityId === UNASSIGNED ? null : hints.assignment.municipalityId;

  return [
    toRawLead(row, {
      release: hints.release,
      scopeKey: item.scopeKey,
      municipalityId,
      cityId: hints.assignment.cityId,
    }),
  ];
}

const adapter: SourceAdapter = {
  id: 'overture-places',
  name: 'Overture Maps Foundation — places theme (Serbia)',
  baseUrl: `${BUCKET_URL}${placesPrefix()}`,
  leadTypes: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
  category: 'open_dataset',
  requiresJs: false,
  // One listing request per run against object storage that publishes no
  // crawl-delay. The delay is generous anyway — there is exactly one request to
  // space out, so nothing is lost by being slow about it.
  config: { requestDelayMs: 2000, requestBudget: 50 },
  // The dataset publishes no contact of its own on a record, so there is
  // nothing to declare here — the emails and profiles on a row belong to the
  // business itself.
  sourceOwnedEmails: [],
  sourceOwnedProfiles: [],
  // The GERS id, not the URL: the URL carries the release, and the same
  // business in next month's release is the same business. Keying staleness on
  // the id is what stops a monthly refresh from re-emitting the whole country.
  resumeKey: (item) => {
    const hints = item.hints as { row?: { id?: unknown } } | undefined;
    const id = hints?.row?.id;
    return typeof id === 'string' ? `gers:${id}` : item.url;
  },
  discover,
  extract,
};

export default adapter;

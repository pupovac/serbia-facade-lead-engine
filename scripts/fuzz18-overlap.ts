/**
 * FUZZ-18 — how much of `gradjevinarstvo-rs` was already known?
 *
 * The question this issue exists to answer, measured rather than estimated.
 *
 * ## What is compared, and why it is the incoming record
 *
 * The obvious measurement — "which stored leads ended up carrying two source
 * ids" — cannot be trusted here, because by the time it is asked the two sides
 * have already been merged into one row. Scoring that row against the baseline
 * scores a record against a copy of itself.
 *
 * So the comparison is run on the **incoming record**: every `raw_records`
 * payload this source emitted, put back through `normalizeRawLead` — the same
 * function the crawl used — and scored against `data/baseline.sqlite`, a copy
 * of the database taken before the crawl holding only `portal-srbija` and
 * `overture-places`. That is exactly the question the issue asks: of the
 * businesses this source published, how many were already in the database?
 *
 * `findCandidates` + `scoreMatch` is the same engine `dedupeDatabase` runs,
 * including the shared-value quarantine, so nothing here is a hand-rolled
 * matcher.
 *
 * The `review` band is reported separately and never folded into "already
 * known". A pair no human has looked at is not a duplicate yet.
 */
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase, type Db } from '@/lib/db';
import {
  findCandidates,
  isSameBusinessName,
  leadRecord,
  loadQuarantine,
  type MatchDecision,
} from '@/lib/dedup';
import { normalizeRawLead } from '@/scraper/pipeline';
import { rawLeadSchema } from '@/scraper/raw-lead';

const SOURCE = 'gradjevinarstvo-rs';
/** The adapter's own declarations, so normalization matches the crawl exactly. */
const SOURCE_OWNED_EMAILS = ['office@gradjevinarstvo.rs', 'redakcija@gradjevinarstvo.rs'];
const SOURCE_OWNED_PROFILES = [
  'https://www.facebook.com/gradjevinarstvo',
  'https://www.twitter.com/gradjevinarstvo',
  'https://www.youtube.com/GradjevinarstvoVideo',
  'https://www.pinterest.com/gradjevinarstvo/',
];

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

const baseline = openDatabase({ url: './data/baseline.sqlite' });
const raw = new Database('./data/leads.sqlite', { readonly: true });

const companiesRead = (
  raw
    .prepare(`select count(*) n from crawl_state where source_id = ? and scope_key like 'item:%'`)
    .get(SOURCE) as { n: number }
).n;

const payloads = raw
  .prepare(`select payload from raw_records where source_id = ? order by id`)
  .all(SOURCE)
  .map((row) => (row as { payload: string }).payload);

const quarantine = loadQuarantine(baseline as Db);

const decisions: MatchDecision[] = [];
const mergeSignals: string[] = [];
const reviewSignals: string[] = [];
const strata: Record<string, { records: number; known: number; review: number }> = {};
const facade = { records: 0, known: 0, review: 0 };
/** Facade relevance read off the source's own words, not off the classifier. */
const FACADE_WORDS = /fasad|termoizolacij|termo\s?izolacij|stiropor|demit|malteris|izolacij/i;
const byLabel: string[] = [];
const facadeByText = { records: 0, known: 0 };
/** A phone-decided merge whose names disagree is the one worth doubting. */
const merges = { nameCorroborated: 0, nameDisagrees: 0 };
const examples: { name: string; city: string; signal: string; against: string }[] = [];
let withPhone = 0;

for (const payload of payloads) {
  const lead = rawLeadSchema.parse(JSON.parse(payload));
  const normalized = normalizeRawLead(lead, {
    sourceOwnedEmails: SOURCE_OWNED_EMAILS,
    sourceOwnedProfiles: SOURCE_OWNED_PROFILES,
  });
  const input = normalized.input;
  if (normalized.phoneCount > 0) withPhone += 1;

  const contacts = input.contacts ?? [];
  // `id: null` — this record has not been written, which is the whole point:
  // nothing excludes it from matching the lead it later merged into.
  const record = leadRecord({
    id: null,
    name: input.name,
    cityId: input.cityId ?? null,
    municipalityId: input.municipalityId ?? null,
    addressNormalized: input.addressNormalized ?? null,
    registrationNumber: input.registrationNumber ?? null,
    taxId: input.taxId ?? null,
    phones: (input.phones ?? []).filter((p) => p.valid !== false).map((p) => p.e164),
    websiteDomains: contacts
      .filter((c) => c.kind === 'website' && c.valid !== false && c.domain)
      .map((c) => c.domain as string),
    emails: contacts.filter((c) => c.kind === 'email' && c.valid !== false).map((c) => c.value),
    socialUrls: contacts
      .filter(
        (c) =>
          (c.kind === 'facebook' || c.kind === 'instagram' || c.kind === 'google_maps') &&
          c.valid !== false,
      )
      .map((c) => c.value),
    sourceIds: [SOURCE],
  });

  const best = findCandidates(baseline as Db, record, { quarantine })[0];
  const decision: MatchDecision = best?.match.decision ?? 'distinct';
  decisions.push(decision);

  const firmId = Number((lead.extra as { firmId?: number }).firmId ?? 0);
  const key = firmId < 10_000 ? 'A: oldest ids 1003–4117' : 'B: newest ids 16115–17471';
  const bucket = (strata[key] ??= { records: 0, known: 0, review: 0 });
  bucket.records += 1;

  const isFacade =
    normalized.classification.label === 'FACADE_CONTRACTOR' ||
    normalized.classification.label === 'BOTH';
  if (isFacade) facade.records += 1;
  byLabel.push(normalized.classification.label);
  const facadeText = FACADE_WORDS.test(
    `${lead.name} ${lead.description ?? ''} ${lead.categories.join(' ')}`,
  );
  if (facadeText) facadeByText.records += 1;

  if (decision === 'merge') {
    bucket.known += 1;
    if (isFacade) facade.known += 1;
    if (facadeText) facadeByText.known += 1;
    mergeSignals.push(best?.match.topSignal ?? 'none');
    if (best !== undefined) {
      if (isSameBusinessName(record.name, best.lead.name)) merges.nameCorroborated += 1;
      else merges.nameDisagrees += 1;
    }
    if (examples.length < 10 && best) {
      examples.push({
        name: lead.name,
        city: String(lead.city ?? ''),
        signal: `${best.match.topSignal}=${best.match.topSignalValue}`,
        against: best.lead.name,
      });
    }
  } else if (decision === 'review') {
    bucket.review += 1;
    if (isFacade) facade.review += 1;
    reviewSignals.push(best?.match.topSignal ?? 'none');
  }
}

const counts = tally(decisions);
const merged = counts.merge ?? 0;
const review = counts.review ?? 0;
const distinct = counts.distinct ?? 0;
const total = payloads.length;
const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;

console.log(
  JSON.stringify(
    {
      crawl: {
        companiesRead,
        registerSize: 11291,
        coverage: `${((companiesRead / 11291) * 100).toFixed(1)}%`,
        recordsEmitted: total,
        droppedAsNonSerbian: companiesRead - total,
        recordsWithAPhone: withPhone,
        phoneCoverage: pct(withPhone),
      },
      overlapAgainstBaseline: {
        baselineLeads: 2072,
        baselineSources: ['portal-srbija', 'overture-places'],
        alreadyKnown: merged,
        alreadyKnownShare: pct(merged),
        needsReview: review,
        needsReviewShare: pct(review),
        new: distinct,
        newShare: pct(distinct),
      },
      decidingSignal: { merge: tally(mergeSignals), review: tally(reviewSignals) },
      byStratum: strata,
      classificationLabels: tally(byLabel),
      facadeClassifiedSlice: facade,
      facadeByOwnWords: facadeByText,
      mergeQuality: merges,
      examples,
    },
    null,
    2,
  ),
);

raw.close();
closeDatabase(baseline);

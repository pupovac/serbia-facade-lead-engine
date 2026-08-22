#!/usr/bin/env node
/**
 * FUZZ-46 — the widened six, measured **per activity code**.
 *
 * FUZZ-45's `fuzz45-overlap.ts` answers the same questions for a crawl as a
 * whole. This one answers them one code at a time, which is the whole point of
 * the issue: `41.20 Izgradnja zgrada` is 5,663 general builders and `71.12
 * Inženjerske delatnosti` is 3,286 engineering firms, both company-heavy, and
 * their phone fill and struck-off rate are not the crawl's average. A single
 * blended number would hide exactly the difference the member is asking to see.
 *
 * Everything is derived from `raw_records` — the untouched adapter payloads —
 * put back through `normalizeRawLead`, the same function the crawl itself used.
 * Nothing is quoted from a run log.
 *
 * ```bash
 * # one baseline snapshot per code, taken before that code was crawled
 * npx tsx scripts/fuzz46-per-code.ts data/leads.sqlite data/fuzz46 data/cache/apr-companies.json
 * ```
 *
 * The baseline directory holds `baseline-<code>.sqlite`. Overlap for a code is
 * scored against the database **as it stood when that code was crawled**, so a
 * business that two codes both publish is counted as already-known the second
 * time — which is the honest reading of "how much of this is new".
 *
 * The APR file is optional; without it every liveness figure is `null` rather
 * than guessed at.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { closeDatabase, openDatabase, type Db } from '@/lib/db';
import { findCandidates, leadRecord, loadQuarantine, type MatchDecision } from '@/lib/dedup';
import { normalizeRawLead } from '@/scraper/pipeline';
import { rawLeadSchema } from '@/scraper/raw-lead';
import { CATEGORIES } from '@/scraper/sources/kompanije-net/categories';

const SOURCE = 'kompanije-net';

/**
 * A matični broj APR open data could hold.
 *
 * FUZZ-45's finding, reused: every registration number in APR's company
 * dataset begins 0, 1 or 2, and a preduzetnik's begins 5 or 6. The page's own
 * `Forma:` field is the weaker signal and is reported beside it, not instead.
 */
const COMPANY_MB = /^[012]/;

const crawlPath = process.argv[2] ?? './data/leads.sqlite';
const baselineDir = process.argv[3] ?? './data/fuzz46';
const aprPath = process.argv[4] ?? null;

const CATEGORY_BY_CODE = new Map(CATEGORIES.map((category) => [category.code, category]));

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

interface AprEntry {
  PoslovnoIme: string;
  NazivStatus: string;
  SifraDelatnosti: string;
  NazivOpstine: string;
}

function loadApr(path: string | null): { cutDate: string; byMb: Map<string, AprEntry> } | null {
  if (path === null || !existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    DatumPreseka: string;
    Podaci: Record<string, AprEntry>;
  };
  return { cutDate: parsed.DatumPreseka, byMb: new Map(Object.entries(parsed.Podaci)) };
}

const apr = loadApr(aprPath);
const crawl = new Database(crawlPath, { readonly: true });

/** Every payload the adapter emitted and the pipeline accepted, in crawl order. */
const payloads = crawl
  .prepare(
    `select payload from raw_records where source_id = ? and status = 'normalized' order by id`,
  )
  .all(SOURCE)
  .map((row) => (row as { payload: string }).payload);

if (payloads.length === 0) {
  throw new Error(`no normalized ${SOURCE} raw records in ${crawlPath} — has the crawl run?`);
}

interface CodeTally {
  records: number;
  withPhone: number;
  distinctPhones: Set<string>;
  withRegistrationNumber: number;
  withTaxId: number;
  withWebsite: number;
  resolvedToMunicipality: number;
  formaPrinted: number;
  companyMb: number;
  soleTraderMb: number;
  pageCodeDiffersFromCategory: number;
  assertedType: string | null;
  assertionsMade: number;
  classifications: string[];
  decisions: MatchDecision[];
  mergeSignals: string[];
  /** matični broj → the APR join, per code. */
  mb: Map<string, { companyMb: boolean; name: string }>;
  examplesAlreadyKnown: { name: string; signal: string; against: string }[];
}

function emptyCodeTally(code: string): CodeTally {
  return {
    records: 0,
    withPhone: 0,
    distinctPhones: new Set(),
    withRegistrationNumber: 0,
    withTaxId: 0,
    withWebsite: 0,
    resolvedToMunicipality: 0,
    formaPrinted: 0,
    companyMb: 0,
    soleTraderMb: 0,
    pageCodeDiffersFromCategory: 0,
    assertedType: CATEGORY_BY_CODE.get(code)?.assertedType ?? null,
    assertionsMade: 0,
    classifications: [],
    decisions: [],
    mergeSignals: [],
    mb: new Map(),
    examplesAlreadyKnown: [],
  };
}

/** One baseline database per code, opened lazily and closed at the end. */
const baselines = new Map<string, { db: Db; quarantine: ReturnType<typeof loadQuarantine> }>();
function baselineFor(
  code: string,
): { db: Db; quarantine: ReturnType<typeof loadQuarantine> } | null {
  const cached = baselines.get(code);
  if (cached !== undefined) return cached;
  const path = `${baselineDir}/baseline-${code}.sqlite`;
  if (!existsSync(path)) return null;
  const db = openDatabase({ url: path });
  const opened = { db, quarantine: loadQuarantine(db) };
  baselines.set(code, opened);
  return opened;
}

const byCode = new Map<string, CodeTally>();

for (const payload of payloads) {
  const lead = rawLeadSchema.parse(JSON.parse(payload));
  const normalized = normalizeRawLead(lead, {});
  const input = normalized.input;
  const extra = lead.extra as { categoryCode?: string };
  const code = extra.categoryCode ?? 'unknown';

  let bucket = byCode.get(code);
  if (bucket === undefined) {
    bucket = emptyCodeTally(code);
    byCode.set(code, bucket);
  }
  bucket.records += 1;

  const phones = (input.phones ?? []).filter((phone) => phone.valid !== false);
  if (phones.length > 0) {
    bucket.withPhone += 1;
    for (const phone of phones) bucket.distinctPhones.add(phone.e164);
  }
  if (input.registrationNumber != null) bucket.withRegistrationNumber += 1;
  if (input.taxId != null) bucket.withTaxId += 1;
  if (input.cityId != null || input.municipalityId != null) bucket.resolvedToMunicipality += 1;

  const contacts = input.contacts ?? [];
  const websites = contacts.filter((contact) => contact.kind === 'website');
  if (websites.length > 0) bucket.withWebsite += 1;

  if (lead.legalForm != null) bucket.formaPrinted += 1;
  const companyMb = input.registrationNumber != null && COMPANY_MB.test(input.registrationNumber);
  if (input.registrationNumber != null) {
    if (companyMb) bucket.companyMb += 1;
    else bucket.soleTraderMb += 1;
    bucket.mb.set(input.registrationNumber, { companyMb, name: lead.name });
  }

  const category = CATEGORY_BY_CODE.get(code);
  if (category !== undefined && lead.activityCode != null && lead.activityCode !== category.sifra) {
    bucket.pageCodeDiffersFromCategory += 1;
  }
  if (lead.assertedType != null) bucket.assertionsMade += 1;
  bucket.classifications.push(normalized.classification.label);

  const baseline = baselineFor(code);
  if (baseline !== null) {
    const record = leadRecord({
      id: null,
      name: input.name,
      cityId: input.cityId ?? null,
      municipalityId: input.municipalityId ?? null,
      addressNormalized: input.addressNormalized ?? null,
      registrationNumber: input.registrationNumber ?? null,
      taxId: input.taxId ?? null,
      phones: phones.map((phone) => phone.e164),
      websiteDomains: websites
        .filter((contact) => contact.valid !== false && contact.domain)
        .map((contact) => contact.domain as string),
      emails: contacts
        .filter((contact) => contact.kind === 'email' && contact.valid !== false)
        .map((contact) => contact.value),
      socialUrls: [],
      sourceIds: [SOURCE],
    });
    const best = findCandidates(baseline.db, record, { quarantine: baseline.quarantine })[0];
    const decision: MatchDecision = best?.match.decision ?? 'distinct';
    bucket.decisions.push(decision);
    if (decision === 'merge' && best !== undefined) {
      bucket.mergeSignals.push(best.match.topSignal ?? 'none');
      if (bucket.examplesAlreadyKnown.length < 5) {
        bucket.examplesAlreadyKnown.push({
          name: lead.name,
          signal: `${best.match.topSignal}=${String(best.match.topSignalValue)}`,
          against: best.lead.name,
        });
      }
    }
  }
}

const share = (n: number, of: number): string | null =>
  of === 0 ? null : `${((n / of) * 100).toFixed(1)}%`;

const report = [...byCode.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([code, t]) => {
    const category = CATEGORY_BY_CODE.get(code);
    const decisions = tally(t.decisions);
    const alreadyKnown = decisions['merge'] ?? 0;
    const review = decisions['review'] ?? 0;

    let liveness: unknown = null;
    if (apr !== null) {
      let present = 0;
      const statuses: string[] = [];
      const struckOff: { mb: string; name: string }[] = [];
      let companyNumbers = 0;
      for (const [mb, seen] of t.mb) {
        if (!seen.companyMb) continue;
        companyNumbers += 1;
        const entry = apr.byMb.get(mb);
        if (entry === undefined) {
          struckOff.push({ mb, name: seen.name });
          continue;
        }
        present += 1;
        statuses.push(entry.NazivStatus);
      }
      const statusCounts = tally(statuses);
      const alive = statusCounts['Активан'] ?? 0;
      liveness = {
        // Measured over the company-number subset alone. APR open data covers
        // privredna društva only, so a sole trader's absence means nothing and
        // is never counted as a dead record.
        distinctCompanyNumbers: companyNumbers,
        presentInApr: present,
        struckOffTheRegister: struckOff.length,
        statusOfThosePresent: statusCounts,
        stillTrading: alive,
        deadOrDying: companyNumbers - alive,
        deadRecordRate: share(companyNumbers - alive, companyNumbers),
        examplesStruckOff: struckOff.slice(0, 5),
      };
    }

    return {
      code,
      name: category?.name ?? null,
      fullPopulation: category?.measuredRecords ?? null,
      sample: {
        recordsExtracted: t.records,
        shareOfCode: share(t.records, category?.measuredRecords ?? 0),
      },
      phone: {
        withPhone: t.withPhone,
        fill: share(t.withPhone, t.records),
        distinctNumbers: t.distinctPhones.size,
      },
      registrationNumber: {
        withRegistrationNumber: t.withRegistrationNumber,
        fill: share(t.withRegistrationNumber, t.records),
      },
      taxId: { withTaxId: t.withTaxId, fill: share(t.withTaxId, t.records) },
      website: { withWebsite: t.withWebsite, fill: share(t.withWebsite, t.records) },
      geography: {
        resolvedToAMunicipality: t.resolvedToMunicipality,
        fill: share(t.resolvedToMunicipality, t.records),
      },
      soleTraders: {
        // The registration-number prefix, which FUZZ-45 showed is the reliable
        // test; `Forma:` is printed on a minority of the records it applies to.
        byRegistrationNumberPrefix: t.soleTraderMb,
        share: share(t.soleTraderMb, t.withRegistrationNumber),
        formaPrintedOnPage: t.formaPrinted,
      },
      classification: {
        assertedTypeForThisCode: t.assertedType,
        assertionsMade: t.assertionsMade,
        labels: tally(t.classifications),
      },
      activityCode: {
        pageDiffersFromDiscoveryCategory: t.pageCodeDiffersFromCategory,
        share: share(t.pageCodeDiffersFromCategory, t.records),
      },
      overlap: {
        against: `${baselineDir}/baseline-${code}.sqlite`,
        alreadyKnown,
        needsReview: review,
        new: t.records - alreadyKnown - review,
        newShare: share(t.records - alreadyKnown - review, t.records),
        mergeSignals: tally(t.mergeSignals),
        examples: t.examplesAlreadyKnown,
      },
      liveness,
    };
  });

console.log(
  JSON.stringify(
    {
      crawl: crawlPath,
      source: SOURCE,
      recordsExtracted: payloads.length,
      apr: apr === null ? null : { cutDate: apr.cutDate, records: apr.byMb.size },
      perCode: report,
    },
    null,
    2,
  ),
);

for (const opened of baselines.values()) closeDatabase(opened.db);
crawl.close();

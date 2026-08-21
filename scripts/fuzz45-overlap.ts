#!/usr/bin/env node
/**
 * FUZZ-45 — what `kompanije-net` is actually worth, measured.
 *
 * Four numbers the issue asks for, all re-derivable from a crawl rather than
 * quoted from a run log:
 *
 * 1. **Field fill** — records extracted, and how many carried a phone, a
 *    matični broj, a PIB, a website.
 * 2. **Overlap against the existing database**, on normalized phone and on
 *    matični broj, using the project's own dedup engine.
 * 3. **The dead-record rate**, cross-checked against APR's open-data register
 *    of *active* companies on matični broj.
 * 4. **Overlap against `apr-opendata`** — the HIGH duplicate risk FUZZ-41
 *    flagged, since both sources derive from APR.
 *
 * ## Why the comparison runs on the incoming record
 *
 * The obvious measurement — "which stored leads ended up with two source ids" —
 * cannot be trusted, because by then the two sides have already been merged
 * into one row and scoring it against the baseline scores a record against a
 * copy of itself. So this reads every `raw_records` payload the adapter emitted,
 * puts it back through `normalizeRawLead` (the same function the crawl used) and
 * scores it against a **baseline database taken before the crawl**. That is the
 * question the issue asks: of the businesses this source published, how many
 * were already known? `fuzz18-overlap.ts` established the pattern.
 *
 * ```bash
 * cp data/leads.sqlite data/baseline.sqlite        # BEFORE crawling kompanije-net
 * npm run scrape -- --source kompanije-net --budget 12000
 * curl -o data/cache/apr-companies.json https://openapi.apr.gov.rs/api/opendata/companies
 * npx tsx scripts/fuzz45-overlap.ts data/leads.sqlite data/baseline.sqlite data/cache/apr-companies.json
 * ```
 *
 * The APR file is optional; without it every APR section is reported as
 * `null` rather than guessed at.
 *
 * ## What the dead-record rate can and cannot say
 *
 * APR open data covers **privredna društva only**. A kompanije.net record whose
 * matični broj is absent from it is either a dead company or a preduzetnik, and
 * those are not the same thing — so the rate is computed only over the records
 * kompanije.net itself marks as companies (the layout that prints `Forma:`).
 * There is no free register-grade liveness check for sole traders, which is
 * exactly what an APR purchase would buy, and this script says so rather than
 * quietly extrapolating.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { closeDatabase, openDatabase, type Db } from '@/lib/db';
import { findCandidates, leadRecord, loadQuarantine, type MatchDecision } from '@/lib/dedup';
import { normalizeRawLead } from '@/scraper/pipeline';
import { rawLeadSchema } from '@/scraper/raw-lead';

const SOURCE = 'kompanije-net';
/** The five codes FUZZ-45 scoped in; anything else is an opt-in `--query` run. */
const CORE_CODES = new Set(['43.31', '43.39', '43.99', '43.34', '43.29']);

const crawlPath = process.argv[2] ?? './data/leads.sqlite';
const baselinePath = process.argv[3] ?? './data/baseline.sqlite';
const aprPath = process.argv[4] ?? null;

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/**
 * APR open data: `{ DatumPreseka, Podaci: { "<matični broj>": {…} } }`.
 *
 * Every record in it is an *active* company — the register publishes the live
 * set, not a history — so presence is the liveness signal and absence is what
 * has to be interpreted carefully.
 */
interface AprEntry {
  PoslovnoIme: string;
  NazivStatus: string;
  SifraDelatnosti: string;
  NazivOpstine: string;
}
function loadApr(path: string | null): { cutDate: string; byMb: Map<string, AprEntry> } | null {
  if (path === null) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    DatumPreseka: string;
    Podaci: Record<string, AprEntry>;
  };
  return { cutDate: parsed.DatumPreseka, byMb: new Map(Object.entries(parsed.Podaci)) };
}

const apr = loadApr(aprPath);
const baseline = openDatabase({ url: baselinePath });
const crawl = new Database(crawlPath, { readonly: true });

const payloads = crawl
  .prepare(
    `select payload from raw_records where source_id = ? and status = 'accepted' order by id`,
  )
  .all(SOURCE)
  .map((row) => (row as { payload: string }).payload);

if (payloads.length === 0) {
  throw new Error(`no accepted ${SOURCE} raw records in ${crawlPath} — has the crawl run?`);
}

const quarantine = loadQuarantine(baseline as Db);

const decisions: MatchDecision[] = [];
const mergeSignals: string[] = [];
const reviewSignals: string[] = [];
/** Per activity code, so a category that is not worth crawling shows up as one. */
const byCode: Record<
  string,
  { records: number; withPhone: number; alreadyKnown: number; review: number }
> = {};
const bySurface: Record<string, number> = {};
const examples: { name: string; city: string; signal: string; against: string }[] = [];

let withPhone = 0;
let withRegistrationNumber = 0;
let withTaxId = 0;
let withWebsite = 0;
let withCityResolved = 0;
let companyLayout = 0;
const phoneE164 = new Set<string>();

/** matični broj → whether the record is one kompanije.net calls a company. */
const mbSeen = new Map<string, { isCompany: boolean; name: string; code: string }>();

for (const payload of payloads) {
  const lead = rawLeadSchema.parse(JSON.parse(payload));
  const normalized = normalizeRawLead(lead, {});
  const input = normalized.input;
  const extra = lead.extra as { surface?: string; categoryCode?: string };
  const code = extra.categoryCode ?? 'unknown';

  const bucket = (byCode[code] ??= { records: 0, withPhone: 0, alreadyKnown: 0, review: 0 });
  bucket.records += 1;
  bySurface[extra.surface ?? 'unknown'] = (bySurface[extra.surface ?? 'unknown'] ?? 0) + 1;

  const phones = (input.phones ?? []).filter((phone) => phone.valid !== false);
  if (phones.length > 0) {
    withPhone += 1;
    bucket.withPhone += 1;
    for (const phone of phones) phoneE164.add(phone.e164);
  }
  if (input.registrationNumber != null) withRegistrationNumber += 1;
  if (input.taxId != null) withTaxId += 1;
  if (input.cityId != null || input.municipalityId != null) withCityResolved += 1;

  const contacts = input.contacts ?? [];
  const websites = contacts.filter((contact) => contact.kind === 'website');
  if (websites.length > 0) withWebsite += 1;

  // kompanije.net prints `Forma:` only on the privredno društvo layout, which
  // is the only subset APR open data can speak to.
  const isCompany = lead.legalForm != null;
  if (isCompany) companyLayout += 1;
  if (input.registrationNumber != null) {
    mbSeen.set(input.registrationNumber, { isCompany, name: lead.name, code });
  }

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
    socialUrls: contacts
      .filter(
        (contact) =>
          (contact.kind === 'facebook' ||
            contact.kind === 'instagram' ||
            contact.kind === 'google_maps') &&
          contact.valid !== false,
      )
      .map((contact) => contact.value),
    sourceIds: [SOURCE],
  });

  const best = findCandidates(baseline as Db, record, { quarantine })[0];
  const decision: MatchDecision = best?.match.decision ?? 'distinct';
  decisions.push(decision);

  if (decision === 'merge') {
    bucket.alreadyKnown += 1;
    mergeSignals.push(best?.match.topSignal ?? 'none');
    if (examples.length < 10 && best !== undefined) {
      examples.push({
        name: lead.name,
        city: String(lead.city ?? ''),
        signal: `${best.match.topSignal}=${String(best.match.topSignalValue)}`,
        against: best.lead.name,
      });
    }
  } else if (decision === 'review') {
    bucket.review += 1;
    reviewSignals.push(best?.match.topSignal ?? 'none');
  }
}

const total = payloads.length;
const pct = (n: number, of = total): string => `${((n / of) * 100).toFixed(1)}%`;
const counts = tally(decisions);

/* ------------------------------------------------------------ APR join -- */

let aprReport: unknown = null;
if (apr !== null) {
  const inApr: string[] = [];
  const companiesInApr: string[] = [];
  const companiesNotInApr: { mb: string; name: string }[] = [];
  const statuses: string[] = [];
  const codeAgreement: string[] = [];

  for (const [mb, seen] of mbSeen) {
    const entry = apr.byMb.get(mb);
    if (entry !== undefined) {
      inApr.push(mb);
      statuses.push(entry.NazivStatus);
      codeAgreement.push(
        entry.SifraDelatnosti === seen.code.replace('.', '') ? 'same code' : 'different code',
      );
      if (seen.isCompany) companiesInApr.push(mb);
    } else if (seen.isCompany) {
      companiesNotInApr.push({ mb, name: seen.name });
    }
  }

  const companies = companyLayout;
  aprReport = {
    cutDate: apr.cutDate,
    aprActiveCompanies: apr.byMb.size,
    note:
      'APR open data covers privredna društva only. A record absent from it is ' +
      'either a dead company or a preduzetnik, so the dead-record rate is ' +
      'computed over the company-layout subset alone.',
    duplicateRisk: {
      distinctMaticniBrojScraped: mbSeen.size,
      alsoInAprOpenData: inApr.length,
      share: pct(inApr.length, mbSeen.size),
      activityCodeAgreement: tally(codeAgreement),
    },
    deadRecordRate: {
      companyLayoutRecords: companies,
      stillActiveInApr: companiesInApr.length,
      absentFromApr: companiesNotInApr.length,
      deadRecordRate: companies === 0 ? null : pct(companiesNotInApr.length, companies),
      aprStatusOfMatches: tally(statuses),
      examplesAbsent: companiesNotInApr.slice(0, 10),
    },
    soleTraders: {
      records: total - companies,
      note: 'No free register-grade liveness check exists for preduzetnici. Every number needs first-call verification.',
    },
  };
}

console.log(
  JSON.stringify(
    {
      crawl: {
        db: crawlPath,
        recordsExtracted: total,
        codesCrawled: Object.keys(byCode).sort(),
        coreCodesOnly: Object.keys(byCode).every((code) => CORE_CODES.has(code)),
        withPhone,
        phoneFill: pct(withPhone),
        distinctPhoneNumbers: phoneE164.size,
        withRegistrationNumber,
        registrationNumberFill: pct(withRegistrationNumber),
        withTaxId,
        taxIdFill: pct(withTaxId),
        withWebsite,
        websiteFill: pct(withWebsite),
        resolvedToAMunicipality: withCityResolved,
        municipalityFill: pct(withCityResolved),
        companyLayoutRecords: companyLayout,
        soleTraderRecords: total - companyLayout,
        bySurface,
      },
      overlapAgainstBaseline: {
        baseline: baselinePath,
        baselineLeads: (
          baseline.$client
            .prepare('select count(*) n from leads where merged_into_id is null')
            .get() as { n: number }
        ).n,
        alreadyKnown: counts.merge ?? 0,
        alreadyKnownShare: pct(counts.merge ?? 0),
        needsReview: counts.review ?? 0,
        needsReviewShare: pct(counts.review ?? 0),
        new: counts.distinct ?? 0,
        newShare: pct(counts.distinct ?? 0),
        decidingSignal: { merge: tally(mergeSignals), review: tally(reviewSignals) },
        examples,
      },
      aprOpenData: aprReport,
      byActivityCode: byCode,
    },
    null,
    2,
  ),
);

crawl.close();
closeDatabase(baseline);

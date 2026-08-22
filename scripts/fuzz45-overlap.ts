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
/**
 * A matični broj APR open data could hold.
 *
 * Every one of the 133,634 registration numbers in that dataset begins 0, 1 or
 * 2; a preduzetnik's begins 5 or 6. The split is what makes a liveness check
 * possible at all — without it a sole trader and a deregistered company are
 * both just "absent".
 */
const COMPANY_MB = /^[012]/;
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
    // `normalized` is what the pipeline stamps on a record that validated and
    // reached the leads table; `rejected` never became a lead and is not yield.
    `select payload from raw_records where source_id = ? and status = 'normalized' order by id`,
  )
  .all(SOURCE)
  .map((row) => (row as { payload: string }).payload);

if (payloads.length === 0) {
  throw new Error(`no normalized ${SOURCE} raw records in ${crawlPath} — has the crawl run?`);
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
let companyMbRecords = 0;
const phoneE164 = new Set<string>();

/** matični broj → what the record was, for the APR join. */
const mbSeen = new Map<
  string,
  { companyMb: boolean; formaPrinted: boolean; name: string; code: string }
>();

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

  // Which records APR open data can speak to at all.
  //
  // The obvious test — does the page print `Forma:`? — turns out to be wrong:
  // in the FUZZ-45 sample only 8 of 38 records carrying a company matični broj
  // printed one. The reliable test is the number itself. APR's registration
  // numbers are allocated by entity type, and the split is total: all 133,634
  // matični brojevi in APR open data begin 0, 1 or 2, while a preduzetnik's
  // begins 5 or 6. `Forma:` is still recorded, as the weaker signal it is.
  const formaPrinted = lead.legalForm != null;
  const companyMb = input.registrationNumber != null && COMPANY_MB.test(input.registrationNumber);
  if (formaPrinted) companyLayout += 1;
  if (companyMb) companyMbRecords += 1;
  if (input.registrationNumber != null) {
    mbSeen.set(input.registrationNumber, { companyMb, formaPrinted, name: lead.name, code });
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
  const status: string[] = [];
  const codeAgreement: string[] = [];
  const soleTraderInApr: string[] = [];
  const deregistered: { mb: string; name: string }[] = [];
  let companyMbInApr = 0;

  for (const [mb, seen] of mbSeen) {
    const entry = apr.byMb.get(mb);
    if (!seen.companyMb) {
      // A sole-trader number should never be in a company register. If one is,
      // the prefix rule this measurement rests on is wrong and it must say so.
      if (entry !== undefined) soleTraderInApr.push(mb);
      continue;
    }
    if (entry === undefined) {
      deregistered.push({ mb, name: seen.name });
      continue;
    }
    companyMbInApr += 1;
    status.push(entry.NazivStatus);
    codeAgreement.push(
      entry.SifraDelatnosti === seen.code.replace('.', '') ? 'same code' : 'different code',
    );
  }

  const statusCounts = tally(status);
  // Present and `Активан` is the only combination that means the business is
  // still trading. Liquidation and bankruptcy are in the dataset with their own
  // status, and absence means struck off the register entirely.
  const alive = statusCounts['Активан'] ?? 0;
  const notAlive = companyMbRecords - alive;

  aprReport = {
    cutDate: apr.cutDate,
    aprRecords: apr.byMb.size,
    method:
      'Joined on matični broj. APR open data covers privredna društva only, and every ' +
      "registration number in it begins 0, 1 or 2 — a preduzetnik's begins 5 or 6 — so the " +
      'liveness check is computed over the company-number subset alone and says nothing about ' +
      'the sole traders, which are most of this source.',
    prefixRuleHolds: soleTraderInApr.length === 0,
    soleTraderNumbersFoundInApr: soleTraderInApr,
    deadRecordRate: {
      companyMbRecords,
      formaPrintedOnPage: companyLayout,
      formaPrintedNote:
        "The page's own `Forma:` field is an unreliable company indicator — see how far it is " +
        'from companyMbRecords. The registration number is the one that holds.',
      presentInApr: companyMbInApr,
      struckOffTheRegister: deregistered.length,
      statusOfThosePresent: statusCounts,
      stillTrading: alive,
      deadOrDying: notAlive,
      deadRecordRate: companyMbRecords === 0 ? null : pct(notAlive, companyMbRecords),
      examplesStruckOff: deregistered.slice(0, 10),
    },
    duplicateRisk: {
      distinctMaticniBrojScraped: mbSeen.size,
      withACompanyNumber: companyMbRecords,
      alreadyInAprOpenData: companyMbInApr,
      shareOfAllRecords: pct(companyMbInApr, mbSeen.size),
      activityCodeAgreement: tally(codeAgreement),
      note:
        'This is the HIGH duplicate risk FUZZ-41 flagged, and it is bounded by how few records ' +
        'here are companies at all. apr-opendata carries no phone, so a match adds a registered ' +
        'name and municipality to a lead this source already brought a number for.',
    },
    soleTraders: {
      records: total - companyMbRecords,
      share: pct(total - companyMbRecords),
      note:
        'No free register-grade liveness check exists for preduzetnici — that is precisely what ' +
        'an APR purchase would buy. Every number needs first-call verification.',
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

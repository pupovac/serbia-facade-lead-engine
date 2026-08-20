/**
 * The enrichment run, end to end.
 *
 * The "web" is a map of URL → fixture, served through the real `PoliteFetcher`,
 * so `robots.txt`, the request budget and the failure policy are exercised
 * rather than stubbed out. Nothing reaches the network, which is what lets this
 * run in CI.
 *
 * The run's own contract is what is under test here, not the confidence rules —
 * those have their own file. What has to hold:
 *
 * - It fetches the homepage, finds the contact page from that same response,
 *   and stops at `MAX_PAGES_PER_SITE`.
 * - Every candidate page ends in exactly one bucket, merged, suggested or
 *   rejected with a named reason, and the buckets add up.
 * - One bad page — a 404, a `robots.txt` disallow, a search provider that will
 *   not answer — is counted and survived, never fatal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  crawlRuns,
  distinctPhones,
  getLead,
  openTestDatabase,
  pendingSuggestions,
  upsertLead,
  upsertSource,
  type Db,
  type LeadInput,
  type Provenance,
} from '@/lib/db';
import { normalizeCompanyName } from '@/lib/normalize';
import { runEnrichment, type EnrichSummary } from './run.js';
import { SearchChallengedError, type CandidateFinder } from './finder.js';
import { OWN_SITE_SOURCE } from './sources.js';

const NOW = new Date('2026-08-20T12:00:00Z');

let db: Db;
let served: string[];

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasaderski-radovi-novi-sad',
  seenAt: new Date('2026-08-01T00:00:00Z'),
};

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const ALLOW_ALL = 'User-agent: *\nAllow: /\n';

/**
 * The pages this test's "web" serves. Anything else is a 404.
 *
 * Both `https://firma.rs` and `https://firma.rs/` are listed, because
 * `canonicalizeWebsite` stores the first form on the lead and a real server
 * answers either.
 */
const WEB: Readonly<Record<string, string>> = {
  'https://mikafasade.rs/robots.txt': ALLOW_ALL,
  'https://mikafasade.rs': fixture('positive/mika-fasade-home.html'),
  'https://mikafasade.rs/': fixture('positive/mika-fasade-home.html'),
  'https://mikafasade.rs/kontakt': fixture('positive/mika-fasade-kontakt.html'),
  'https://mikafasade.rs/o-nama': fixture('positive/mika-fasade-home.html'),
  'https://mikafasade.rs/usluge': fixture('positive/mika-fasade-home.html'),
  'https://petrovic-fasade-ns.rs/robots.txt': ALLOW_ALL,
  'https://petrovic-fasade-ns.rs': fixture('negative/fasade-petrovic-novi-sad-drugi.html'),
  'https://petrovic-fasade-ns.rs/': fixture('negative/fasade-petrovic-novi-sad-drugi.html'),
  'https://zatvoren.rs/robots.txt': 'User-agent: *\nDisallow: /\n',
  'https://zatvoren.rs': '<html><body>nikad</body></html>',
};

function web(): (url: string) => Promise<Response> {
  return async (url: string) => {
    served.push(url);
    const body = WEB[url];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': url.endsWith('robots.txt') ? 'text/plain' : 'text/html' },
    });
  };
}

function store(name: string, overrides: Partial<LeadInput> = {}): number {
  return upsertLead(
    db,
    {
      name,
      nameNormalized: normalizeCompanyName(name).ascii,
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      classification: 'FACADE_CONTRACTOR',
      classificationConfidence: 0.9,
      ...overrides,
    },
    PORTAL,
  ).leadId;
}

function withSite(name: string, url: string, domain: string): number {
  return store(name, { contacts: [{ kind: 'website', value: url, domain }] });
}

function run(options: Parameters<typeof runEnrichment>[0] = {}): Promise<EnrichSummary> {
  return runEnrichment({
    db,
    config: { requestDelayMs: 0 },
    fetchImpl: web() as never,
    sleep: async () => {},
    random: () => 0.5,
    now: () => NOW,
    ...options,
  });
}

/** A finder that always refuses, the way the real one does today. */
const CHALLENGED: CandidateFinder = {
  id: 'test-challenged',
  search: async () => {
    throw new SearchChallengedError('test-challenged');
  },
};

/** A finder that returns one page we control. */
const FINDS_PETROVIC: CandidateFinder = {
  id: 'test-finder',
  search: async () => [
    { url: 'https://petrovic-fasade-ns.rs/', title: 'Fasade Petrović', snippet: '', rank: 1 },
  ],
};

beforeEach(() => {
  db = openTestDatabase();
  served = [];
  upsertSource(db, {
    id: 'portal-srbija',
    name: 'Portal Srbija',
    url: 'https://www.portal-srbija.com',
    category: 'directory',
  });
});

afterEach(() => {
  closeDatabase(db);
});

/* -------------------------------------------------------------------------- */
/* The own-site path                                                          */
/* -------------------------------------------------------------------------- */

describe('the own-site path', () => {
  it('reads the homepage, follows its contact link, and enriches the lead', async () => {
    const leadId = withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    const summary = await run({ path: 'own-site' });

    expect(summary.leadsProcessed).toBe(1);
    expect(summary.leadsEnriched).toBe(1);
    expect(summary.leadsGainedFirstPhone).toBe(1);
    expect(summary.fieldsAdded.phone).toBe(2);
    expect(distinctPhones(db, leadId).map((phone) => phone.e164)).toEqual([
      '+381641234567',
      '+381652223344',
    ]);
  });

  it('asks robots.txt before it asks for a page', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    await run({ path: 'own-site' });

    expect(served[0]).toBe('https://mikafasade.rs/robots.txt');
  });

  it('finds the contact page from the homepage rather than guessing URLs', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    await run({ path: 'own-site' });

    const pages = served.filter((url) => !url.endsWith('robots.txt'));
    expect(pages).toContain('https://mikafasade.rs/kontakt');
    // `/kontakt.html`, `/contact`, `/kontakt.php` — never asked for.
    expect(pages.every((url) => url in WEB)).toBe(true);
  });

  it('stops at four pages of one site', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    const summary = await run({ path: 'own-site' });

    expect(summary.pagesFetched).toBeLessThanOrEqual(4);
  });

  it('counts a page it cannot fetch instead of failing the run', async () => {
    withSite('Nepostojeća Firma', 'https://mikafasade.rs/nema-ovoga', 'mikafasade.rs');
    const summary = await run({ path: 'own-site' });

    expect(summary.status).toBe('completed');
    expect(summary.rejections.fetch_failed).toBe(1);
    expect(summary.pagesFetched).toBe(0);
  });

  it('obeys a robots.txt disallow and says so', async () => {
    withSite('Zatvorena Firma', 'https://zatvoren.rs', 'zatvoren.rs');
    const summary = await run({ path: 'own-site' });

    expect(summary.rejections.robots_disallowed).toBe(1);
    expect(summary.pagesFetched).toBe(0);
    expect(served).toEqual(['https://zatvoren.rs/robots.txt']);
  });

  it('does not put an unreachable site back at the top of the next run', async () => {
    // Its potential gain never changes, so without recording the visit this
    // lead would be re-selected first on every run and the queue behind it
    // would never advance.
    withSite('Zatvorena Firma', 'https://zatvoren.rs', 'zatvoren.rs');
    await run({ path: 'own-site' });
    const second = await run({
      path: 'own-site',
      select: { stalenessMs: 30 * 24 * 60 * 60 * 1000 },
    });

    expect(second.targetsSelected).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The search path                                                            */
/* -------------------------------------------------------------------------- */

describe('scoping a run to one path', () => {
  it('selects the leads that path can actually reach, not the best leads overall', async () => {
    // `--path own-site --limit 1` must not spend its one slot on the lead with
    // the highest potential gain if that lead has no website: the own-site path
    // cannot reach it, and the run would do nothing at all.
    store('Fasade Petrović');
    const reachable = withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    const summary = await run({ path: 'own-site', limit: 1 });

    expect(summary.targetsSelected).toBe(1);
    expect(summary.leadsProcessed).toBe(1);
    expect(distinctPhones(db, reachable)).not.toEqual([]);
  });
});

describe('the search path', () => {
  it('queues a medium-confidence page for review instead of merging it', async () => {
    const leadId = store('Fasade Petrović');
    const summary = await run({ path: 'search', finder: FINDS_PETROVIC });

    expect(summary.pagesMerged).toBe(0);
    expect(summary.pagesSuggested).toBe(1);
    expect(summary.suggestionsQueued).toBeGreaterThan(0);
    // Nothing was written onto the lead.
    expect(distinctPhones(db, leadId)).toEqual([]);

    const queued = pendingSuggestions(db, { leadId });
    expect(queued.map((row) => row.rule)).toEqual(queued.map(() => 'name_city_alone'));
  });

  it('reports a provider that refuses to answer, and does not pretend it found nothing', async () => {
    store('Fasade Petrović');
    const summary = await run({ path: 'search', finder: CHALLENGED });

    expect(summary.status).toBe('completed');
    expect(summary.rejections.search_unavailable).toBe(1);
    expect(summary.pagesFetched).toBe(0);
    expect(summary.suggestionsQueued).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Bookkeeping                                                                */
/* -------------------------------------------------------------------------- */

describe('the run row and the summary', () => {
  it('puts every candidate page in exactly one bucket', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    store('Fasade Petrović');
    const summary = await run({ finder: FINDS_PETROVIC });

    const rejectedPages = Object.entries(summary.rejections)
      .filter(([reason]) => reason !== 'robots_disallowed' && reason !== 'fetch_failed')
      .reduce((total, [, count]) => total + (count ?? 0), 0);
    expect(summary.pagesMerged + summary.pagesSuggested + rejectedPages).toBe(summary.pagesFetched);
  });

  it('writes the tally onto the crawl_runs row', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    const summary = await run({ path: 'own-site' });

    const row = db.select().from(crawlRuns).all()[0];
    expect(row?.status).toBe('completed');
    expect(row?.sourceId).toBe(OWN_SITE_SOURCE);
    expect(row?.phonesAdded).toBe(2);
    expect(JSON.parse(row?.notes ?? '{}')).toMatchObject({
      fieldsAdded: summary.fieldsAdded,
      rejections: summary.rejections,
    });
  });

  it('stops when the request budget is gone and says why', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    withSite('Druga Firma', 'https://petrovic-fasade-ns.rs', 'petrovic-fasade-ns.rs');
    const summary = await run({
      path: 'own-site',
      config: { requestBudget: 2, requestDelayMs: 0 },
    });

    expect(summary.stoppedBecause).toContain('budget');
    expect(summary.requests).toBeLessThanOrEqual(2);
  });

  it('re-scores the lead it enriched', async () => {
    const leadId = withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    const before = getLead(db, leadId)?.leadScore ?? 0;
    const summary = await run({ path: 'own-site' });

    expect(getLead(db, leadId)?.leadScore).toBeGreaterThan(before);
    expect(summary.scorePointsAdded).toBeGreaterThan(0);
  });

  it('selects nothing on a second run, because the leads are no longer stale', async () => {
    withSite('Mika Fasade', 'https://mikafasade.rs', 'mikafasade.rs');
    await run({ path: 'own-site' });
    const second = await run({
      path: 'own-site',
      select: { stalenessMs: 30 * 24 * 60 * 60 * 1000 },
    });

    expect(second.targetsSelected).toBe(0);
    expect(second.pagesFetched).toBe(0);
  });
});

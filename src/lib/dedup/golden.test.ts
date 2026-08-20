/**
 * The golden test: 54 scraped records go in, an exact number of leads comes out.
 *
 * Every other test in this module checks one rule in isolation. This one checks
 * that the rules *together* produce the right answer on a set that contains all
 * of them at once — which is the only way to catch a guard that fires on a case
 * a different rule should have handled, or a merge that only looks right until
 * a third record joins the pair.
 *
 * The expected lead count is asserted exactly. It is derived from the fixture's
 * `business` ground truth rather than typed as a literal, so a record added to
 * `fixtures.ts` moves the expectation with it instead of quietly breaking it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  activeLeadCount,
  activeLeads,
  distinctPhones,
  getSharedIdentifier,
  leadSourceRows,
  pendingMergeCandidates,
  resolveLead,
  resolveMergeCandidate,
  upsertMergeCandidate,
  upsertSource,
} from '../db/repo.js';
import type { Lead } from '../db/schema.js';
import {
  FIXTURES,
  FIXTURE_SOURCES,
  duplicatedBusinesses,
  expectedBusinessCount,
  fixtureInput,
  fixtureProvenance,
  type FixtureRecord,
} from './fixtures.js';
import { ingestLead } from './ingest.js';
import { dedupeDatabase, type SweepStats } from './sweep.js';

let db: Db;
const SEEN_AT = new Date('2026-08-20T09:00:00Z');

/** The switchboard the five unrelated Belgrade companies all publish. */
const SWITCHBOARD = '+381119998800';
/** The directory that prints its own address on every entry it lists. */
const DIRECTORY_EMAIL = 'kontakt@portal-srbija.com';

beforeEach(() => {
  db = openTestDatabase();
  for (const source of FIXTURE_SOURCES) {
    upsertSource(db, {
      id: source.id,
      name: source.name,
      url: `https://${source.id}.rs/`,
      category: 'fixture',
      priority: source.priority,
    });
  }
});

afterEach(() => {
  closeDatabase(db);
});

/** Ingest all 54 records the way the orchestrator will, then sweep. */
function runPipeline(): SweepStats {
  for (const record of FIXTURES) {
    ingestLead(db, fixtureInput(record), fixtureProvenance(record, SEEN_AT), { at: SEEN_AT });
  }
  return dedupeDatabase(db, { at: SEEN_AT });
}

/** Which lead each fixture record ended up on, by ground-truth business key. */
function leadsByBusiness(): Map<string, Set<number>> {
  const byBusiness = new Map<string, Set<number>>();
  const byUrl = new Map<string, FixtureRecord>();
  for (const record of FIXTURES) {
    byUrl.set(fixtureProvenance(record, SEEN_AT).sourceUrl, record);
  }

  for (const lead of activeLeads(db)) {
    for (const row of leadSourceRows(db, lead.id)) {
      const record = byUrl.get(row.sourceUrl);
      if (!record) continue;
      const set = byBusiness.get(record.business) ?? new Set<number>();
      set.add(lead.id);
      byBusiness.set(record.business, set);
    }
  }
  return byBusiness;
}

/* -------------------------------------------------------------------------- */

describe('the golden fixture set', () => {
  it('collapses 54 records into exactly one lead per business', () => {
    const stats = runPipeline();

    expect(FIXTURES).toHaveLength(54);
    expect(activeLeadCount(db)).toBe(expectedBusinessCount());
    expect(activeLeadCount(db)).toBe(43);
    expect(stats.roundsExhausted).toBe(false);
    expect(stats.blocksTruncated).toBe(0);
  });

  it('puts every record of a business on the same lead, and no two businesses together', () => {
    runPipeline();
    const byBusiness = leadsByBusiness();

    // Nothing was split: each business is on exactly one lead.
    for (const [business, leadIds] of byBusiness) {
      expect(`${business}: ${leadIds.size}`).toBe(`${business}: 1`);
    }

    // Nothing was fused: no lead carries two businesses.
    const owner = new Map<number, string>();
    for (const [business, leadIds] of byBusiness) {
      for (const leadId of leadIds) {
        expect(owner.get(leadId) ?? business).toBe(business);
        owner.set(leadId, business);
      }
    }
    expect(owner.size).toBe(expectedBusinessCount());
  });

  it('finds every duplicate the fixture set contains', () => {
    runPipeline();
    const duplicates = duplicatedBusinesses();
    expect(duplicates).toHaveLength(8);

    // Every duplicated business is now a single lead carrying more than one
    // source sighting — which is what "merged, not dropped" looks like.
    for (const business of duplicates) {
      const leadIds = leadsByBusiness().get(business);
      expect(leadIds?.size).toBe(1);
      const [leadId] = [...(leadIds ?? [])];
      expect(leadSourceRows(db, leadId ?? 0).length).toBeGreaterThan(1);
    }
  });

  it('reports a duplicate rate and a decision distribution', () => {
    const stats = runPipeline();

    // 54 records in, 43 businesses out: a 20.4% duplicate rate over the set.
    // Most of it is collapsed at ingestion, where a record is attached to the
    // lead it already is; the sweep catches what only exists once both sides
    // are stored.
    expect(stats.leadsBefore).toBeGreaterThan(stats.leadsAfter);
    expect(stats.duplicateRate).toBeGreaterThan(0);
    expect(stats.merged).toBeGreaterThan(0);
    expect(stats.decisions.merge + stats.decisions.review + stats.decisions.distinct).toBe(
      stats.pairsScored,
    );

    // The review queue is one pair — the two separately registered companies
    // sharing a line. Everything else the engine either decided or refused to
    // ask about. A queue that fills with pairs the guards already answered is
    // a queue nobody reads.
    expect(stats.decisions.review).toBe(1);
    expect(pendingMergeCandidates(db)).toHaveLength(1);
  });

  it('withdraws a queued pair the rules have stopped proposing', () => {
    // A pair can be queued and then answered — most often because the
    // quarantine disarmed the value that connected the two leads after the
    // pair was parked. Leaving it in the queue asks a human to decide a
    // question the engine no longer has.
    runPipeline();
    const leads = leadsByBusiness();
    const [beton] = [...(leads.get('beton') ?? [])];
    const [leskovac] = [...(leads.get('leskovac-fasade') ?? [])];

    upsertMergeCandidate(db, {
      leadAId: beton ?? 0,
      leadBId: leskovac ?? 0,
      score: 0.6,
      topSignal: 'phone',
      signalValue: '+381119998800',
      signals: '[]',
      seenAt: SEEN_AT,
    });
    expect(pendingMergeCandidates(db)).toHaveLength(2);

    const stats = dedupeDatabase(db, { at: SEEN_AT });

    expect(stats.reviewWithdrawn).toBe(1);
    expect(pendingMergeCandidates(db)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The cases the set exists to prove                                          */
/* -------------------------------------------------------------------------- */

describe('the individual cases, end to end', () => {
  function leadFor(business: string): Lead {
    const leadIds = leadsByBusiness().get(business);
    const [leadId] = [...(leadIds ?? [])];
    const lead = leadId == null ? undefined : resolveLead(db, leadId);
    if (!lead) throw new Error(`no lead for ${business}`);
    return lead;
  }

  it('joins one fasader from four directories, keeping both his numbers', () => {
    runPipeline();
    const lead = leadFor('fasader-plus');

    expect(leadSourceRows(db, lead.id)).toHaveLength(4);
    const phones = distinctPhones(db, lead.id)
      .map((phone) => phone.e164)
      .sort();
    expect(phones).toEqual(['+381214445566', '+381641112233']);
    // Every raw spelling the four sources published is still there.
    const raws = distinctPhones(db, lead.id).flatMap((phone) => phone.rawVariants);
    expect(raws).toContain('064/111-2233');
    expect(raws).toContain('+381 64 111 2233');
  });

  it('joins a record reached only by domain to one reached only by email', () => {
    runPipeline();
    expect(leadSourceRows(db, leadFor('termo-dom').id)).toHaveLength(3);
  });

  it('keeps the two `Fasade Petrović` apart, because they are in two cities', () => {
    runPipeline();
    expect(leadFor('petrovic-nis').id).not.toBe(leadFor('petrovic-novi-sad').id);
    expect(leadFor('petrovic-nis').cityId).toBe('nis');
    expect(leadFor('petrovic-novi-sad').cityId).toBe('novi-sad');
  });

  it('merges a name match on a shared address with nothing else in common', () => {
    runPipeline();
    expect(leadSourceRows(db, leadFor('markovic-kg').id)).toHaveLength(2);
    // And does not drag in the other Kragujevac fasader with a similar name.
    expect(leadFor('marko-kg').id).not.toBe(leadFor('markovic-kg').id);
  });

  it('keeps one stovarište with two yards as one lead and two addresses', () => {
    runPipeline();
    const lead = leadFor('dunav-stovariste');
    expect(leadSourceRows(db, lead.id)).toHaveLength(2);
    expect(distinctPhones(db, lead.id)).toHaveLength(1);
  });

  it('keeps two similarly named Belgrade stovarišta apart', () => {
    runPipeline();
    expect(leadFor('beton').id).not.toBe(leadFor('beton-plus').id);
  });
});

/* -------------------------------------------------------------------------- */
/* The guards                                                                 */
/* -------------------------------------------------------------------------- */

describe('the guards, on the golden set', () => {
  it('quarantines the switchboard and leaves its five businesses apart', () => {
    const stats = runPipeline();

    const row = getSharedIdentifier(db, 'phone', SWITCHBOARD);
    expect(row?.quarantined).toBe(true);
    expect(row?.reason).toBe('shared_across_businesses');
    expect(row?.distinctBusinesses).toBe(5);
    expect(stats.quarantine.byKind.phone).toBe(1);

    const leads = leadsByBusiness();
    const ids = new Set(
      [
        'kc-fasade-jovanovic',
        'kc-izolacija-nikolic',
        'kc-termo-sistem',
        'kc-zoran',
        'kc-stovariste-sava',
      ].flatMap((business) => [...(leads.get(business) ?? [])]),
    );
    expect(ids.size).toBe(5);
  });

  it('refuses to identify a business by the directory address printed on its listing', () => {
    const stats = runPipeline();

    const row = getSharedIdentifier(db, 'email', DIRECTORY_EMAIL);
    expect(row?.quarantined).toBe(true);
    expect(row?.reason).toBe('directory_owned');
    expect(stats.quarantine.byKind.email).toBe(1);

    const leads = leadsByBusiness();
    expect([...(leads.get('subotica-fasade') ?? [])]).not.toEqual([
      ...(leads.get('subotica-stovariste') ?? []),
    ]);
  });

  it('sends the two separately registered companies on one line to a human', () => {
    runPipeline();
    const leads = leadsByBusiness();
    const [komerc] = [...(leads.get('komerc-gradnja') ?? [])];
    const [trade] = [...(leads.get('komerc-trade') ?? [])];
    expect(komerc).not.toBe(trade);

    const pending = pendingMergeCandidates(db);
    const pair = pending.find(
      (candidate) =>
        [candidate.leadAId, candidate.leadBId].includes(komerc ?? -1) &&
        [candidate.leadAId, candidate.leadBId].includes(trade ?? -2),
    );
    expect(pair).toBeDefined();
    expect(pair?.status).toBe('pending');
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence                                                                */
/* -------------------------------------------------------------------------- */

describe('re-running dedup over an already-merged database', () => {
  it('changes nothing the second time', () => {
    runPipeline();
    const after = activeLeadCount(db);
    const pendingBefore = pendingMergeCandidates(db).map((candidate) => candidate.id);

    const second = dedupeDatabase(db, { at: SEEN_AT });

    expect(second.merged).toBe(0);
    expect(second.rounds).toBe(1);
    expect(activeLeadCount(db)).toBe(after);
    expect(pendingMergeCandidates(db).map((candidate) => candidate.id)).toEqual(pendingBefore);
  });

  it('changes nothing when the whole crawl is replayed', () => {
    runPipeline();
    const after = activeLeadCount(db);

    // A second crawl of every source, seeing the same pages again.
    for (const record of FIXTURES) {
      ingestLead(db, fixtureInput(record), fixtureProvenance(record, SEEN_AT), { at: SEEN_AT });
    }
    dedupeDatabase(db, { at: SEEN_AT });

    expect(activeLeadCount(db)).toBe(after);
  });

  it('does not re-propose a pair a reviewer has rejected', () => {
    runPipeline();
    const [first] = pendingMergeCandidates(db);
    expect(first).toBeDefined();

    resolveMergeCandidate(db, first?.id ?? 0, 'rejected', { resolvedBy: 'reviewer:1' });
    const stats = dedupeDatabase(db, { at: SEEN_AT });

    expect(pendingMergeCandidates(db).map((candidate) => candidate.id)).not.toContain(first?.id);
    expect(stats.reviewAlreadyDecided).toBeGreaterThan(0);
  });
});

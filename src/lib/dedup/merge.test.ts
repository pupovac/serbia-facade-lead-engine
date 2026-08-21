/**
 * What a merge does to the data, and what an unmerge undoes.
 *
 * The property under test throughout is **union, never truncation**: the merged
 * lead comes out with everything both sides had. A merge that quietly drops one
 * of two phone numbers is worse than no merge at all — the duplicate row was at
 * least still callable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  distinctPhones,
  fieldConflicts,
  getLead,
  getMergeLogEntry,
  leadContactClaims,
  leadSourceRows,
  mergesOnQuarantinedIdentifiers,
  pendingMergeCandidates,
  resolveLead,
  setManualQuarantine,
  upsertLead,
  upsertMergeCandidate,
  upsertSource,
  type LeadInput,
  type Provenance,
} from '../db/repo.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { chooseSurvivor, mergeLeads, unmergeLeads } from './merge.js';
import { leadRecord, toLeadRecord } from './from-db.js';
import type { MatchReason } from './types.js';

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasaderski-radovi-novi-sad',
};
const NAVIDIKU: Provenance = {
  sourceId: 'navidiku-rs',
  sourceUrl: 'https://www.navidiku.rs/firme/fasaderski-radovi/novi-sad',
};
const OGLASI: Provenance = {
  sourceId: 'oglasi-rs',
  sourceUrl: 'https://www.oglasi.rs/oglas/fasaderski-radovi-12345',
};

const PHONE_REASON: MatchReason = {
  signal: 'phone',
  signalValue: '+381641112233',
  score: 0.95,
};

function lead(name: string, overrides: Partial<LeadInput> = {}): LeadInput {
  return { name, nameNormalized: normalizeCompanyName(name).ascii, ...overrides };
}

beforeEach(() => {
  db = openTestDatabase();
  // Two ranked directories and one classifieds site: the trust order that
  // decides a name conflict.
  upsertSource(db, {
    id: 'portal-srbija',
    name: 'Portal Srbija',
    url: 'https://www.portal-srbija.com/',
    category: 'directory',
    priority: 'high',
  });
  upsertSource(db, {
    id: 'navidiku-rs',
    name: 'Na vidiku',
    url: 'https://www.navidiku.rs/',
    category: 'directory',
    priority: 'medium',
  });
  upsertSource(db, {
    id: 'oglasi-rs',
    name: 'Oglasi',
    url: 'https://www.oglasi.rs/',
    category: 'classifieds',
    priority: 'low',
  });
});

afterEach(() => {
  closeDatabase(db);
});

/* -------------------------------------------------------------------------- */
/* Union, never truncation                                                    */
/* -------------------------------------------------------------------------- */

describe('mergeLeads keeps everything from both sides', () => {
  it('keeps every phone, email, website and source URL', () => {
    const a = upsertLead(
      db,
      lead('Fasader Plus d.o.o.', {
        cityId: 'novi-sad',
        phones: [{ e164: '+381641112233', raw: '064/111-2233', type: 'mobile' }],
        contacts: [{ kind: 'email', value: 'info@fasaderplus.rs' }],
      }),
      PORTAL,
    );
    const b = upsertLead(
      db,
      lead('Fasader Plus Komerc', {
        cityId: 'novi-sad',
        phones: [{ e164: '+381214445566', raw: '021/444-5566', type: 'landline' }],
        contacts: [
          { kind: 'website', value: 'https://fasaderplus.rs', domain: 'fasaderplus.rs' },
          { kind: 'facebook', value: 'https://www.facebook.com/fasaderplus' },
        ],
      }),
      NAVIDIKU,
    );

    const outcome = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);
    expect(outcome.merged).toBe(true);

    const phones = distinctPhones(db, a.leadId)
      .map((phone) => phone.e164)
      .sort();
    expect(phones).toEqual(['+381214445566', '+381641112233']);

    const contacts = leadContactClaims(db, a.leadId)
      .map((contact) => contact.value)
      .sort();
    expect(contacts).toEqual([
      'https://fasaderplus.rs',
      'https://www.facebook.com/fasaderplus',
      'info@fasaderplus.rs',
    ]);

    const sourceUrls = leadSourceRows(db, a.leadId)
      .map((row) => row.sourceUrl)
      .sort();
    expect(sourceUrls).toEqual([NAVIDIKU.sourceUrl, PORTAL.sourceUrl].sort());
  });

  it('leaves the merged-away lead resolvable rather than deleting it', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Novak Komerc', { cityId: 'nis' }), NAVIDIKU);

    mergeLeads(db, a.leadId, b.leadId, { signal: 'name_city', signalValue: 'fasade novak' });

    expect(getLead(db, b.leadId)?.mergedIntoId).toBe(a.leadId);
    expect(getLead(db, b.leadId)?.status).toBe('merged');
    // Every id ever handed out keeps resolving.
    expect(resolveLead(db, b.leadId)?.id).toBe(a.leadId);
  });

  it('fills the survivor from the merged lead without overwriting what it had', () => {
    const a = upsertLead(
      db,
      lead('Fasade Novak', { cityId: 'nis', address: 'Vojvode Putnika 3' }),
      PORTAL,
    );
    const b = upsertLead(
      db,
      lead('Fasade Novak Komerc', {
        cityId: 'nis',
        address: 'Vojvode Putnika 5',
        registrationNumber: '20123456',
        description: 'Demit fasade i termoizolacija.',
      }),
      NAVIDIKU,
    );

    mergeLeads(db, a.leadId, b.leadId, { signal: 'name_city', signalValue: 'fasade novak' });

    const survivor = getLead(db, a.leadId);
    // A blank is filled...
    expect(survivor?.registrationNumber).toBe('20123456');
    expect(survivor?.description).toBe('Demit fasade i termoizolacija.');
    // ...and the address it already had is not silently swapped out.
    expect(survivor?.address).toBe('Vojvode Putnika 3');
  });

  it('re-grades the survivor rather than carrying the old label forward', () => {
    // The first record has nothing to classify on. The second brings the words.
    const a = upsertLead(db, lead('Veljko', { cityId: 'beograd' }), PORTAL);
    const b = upsertLead(
      db,
      lead('Veljko fasade', {
        cityId: 'beograd',
        description: 'Izrada demit fasada, termoizolacija, molersko-fasaderski radovi.',
        phones: [{ e164: '+381641112233', raw: '064/111-2233' }],
      }),
      NAVIDIKU,
    );
    expect(getLead(db, a.leadId)?.classification).toBe('UNCLASSIFIED');

    const outcome = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);

    expect(outcome.regraded?.classification).toBe('FACADE_CONTRACTOR');
    expect(getLead(db, a.leadId)?.classification).toBe('FACADE_CONTRACTOR');
    expect(getLead(db, a.leadId)?.leadScore).toBeGreaterThan(0);
    expect(getLead(db, a.leadId)?.classificationEvidence).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Conflicts on the fields that hold one value                                */
/* -------------------------------------------------------------------------- */

describe('conflicts on singular fields', () => {
  it('keeps the higher-trust name and records the other', () => {
    // The classifieds ad went in first, so it holds the row. The ranked
    // directory's spelling should win it, and the ad's should survive as a claim.
    const a = upsertLead(db, lead('FASADE NOVAK -- POVOLJNO!!', { cityId: 'nis' }), OGLASI);
    const b = upsertLead(db, lead('Fasade Novak d.o.o.', { cityId: 'nis' }), PORTAL);

    const outcome = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);

    const nameConflict = outcome.conflictsResolved.find((c) => c.field === 'name');
    expect(nameConflict?.kept).toBe('Fasade Novak d.o.o.');
    expect(nameConflict?.decidedBy).toBe('source_trust');
    expect(getLead(db, a.leadId)?.name).toBe('Fasade Novak d.o.o.');

    // Nothing is discarded: the losing spelling is still a claim with its own
    // provenance, which is what the review UI shows.
    const stored = fieldConflicts(db, a.leadId).find((c) => c.field === 'name');
    expect(stored?.claims.map((claim) => claim.value)).toContain('FASADE NOVAK -- POVOLJNO!!');
  });

  it('records a city conflict when two locations of one business merge', () => {
    const a = upsertLead(
      db,
      lead('Gradnja Komerc', { cityId: 'beograd', cityRaw: 'Beograd' }),
      PORTAL,
    );
    const b = upsertLead(
      db,
      lead('Gradnja Komerc', { cityId: 'novi-sad', cityRaw: 'Novi Sad' }),
      NAVIDIKU,
    );

    const outcome = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);

    const city = outcome.conflictsResolved.find((c) => c.field === 'city');
    expect(city?.alsoRecorded).toHaveLength(1);
    expect([city?.kept, ...(city?.alsoRecorded ?? [])].sort()).toEqual(['Beograd', 'Novi Sad']);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence                                                                */
/* -------------------------------------------------------------------------- */

describe('idempotence', () => {
  it('refuses a second merge of the same pair and changes nothing', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Novak Komerc', { cityId: 'nis' }), NAVIDIKU);

    const first = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);
    const second = mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);

    expect(first.merged).toBe(true);
    expect(second.merged).toBe(false);
    expect(second.refusal).toBe('already_merged');
    expect(second.result).toBeNull();
  });

  it('refuses a merge stated the other way round, too', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Novak Komerc', { cityId: 'nis' }), NAVIDIKU);

    mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);
    expect(mergeLeads(db, b.leadId, a.leadId, PHONE_REASON).refusal).toBe('already_merged');
  });

  it('refuses a merge into a lead that no longer exists', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    expect(mergeLeads(db, a.leadId, 9999, PHONE_REASON).refusal).toBe('missing_lead');
  });
});

/* -------------------------------------------------------------------------- */
/* The quarantine guard, at the merge                                         */
/* -------------------------------------------------------------------------- */

describe('the quarantine refuses a merge', () => {
  const switchboard = '+381113334455';

  it('will not merge on a quarantined number', () => {
    const a = upsertLead(db, lead('Fasade Jovanović', { cityId: 'beograd' }), PORTAL);
    const b = upsertLead(db, lead('Stovarište Dunav', { cityId: 'beograd' }), NAVIDIKU);
    setManualQuarantine(db, 'phone', switchboard, true, 'call centre');

    const outcome = mergeLeads(db, a.leadId, b.leadId, {
      signal: 'phone',
      signalValue: switchboard,
    });

    expect(outcome.merged).toBe(false);
    expect(outcome.refusal).toBe('quarantined_signal');
    expect(getLead(db, b.leadId)?.mergedIntoId).toBeNull();
  });

  it('lets a human force it through', () => {
    const a = upsertLead(db, lead('Fasade Jovanović', { cityId: 'beograd' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Jovanovic Gradnja', { cityId: 'beograd' }), NAVIDIKU);
    setManualQuarantine(db, 'phone', switchboard, true);

    const outcome = mergeLeads(
      db,
      a.leadId,
      b.leadId,
      { signal: 'phone', signalValue: switchboard, actor: 'reviewer:1' },
      { force: true },
    );
    expect(outcome.merged).toBe(true);
  });

  it('finds a merge whose deciding number was quarantined afterwards', () => {
    const a = upsertLead(db, lead('Fasade Jovanović', { cityId: 'beograd' }), PORTAL);
    const b = upsertLead(db, lead('Stovarište Dunav', { cityId: 'beograd' }), NAVIDIKU);
    const outcome = mergeLeads(db, a.leadId, b.leadId, {
      signal: 'phone',
      signalValue: switchboard,
    });
    expect(outcome.merged).toBe(true);

    // A later crawl reveals what the number really is.
    setManualQuarantine(db, 'phone', switchboard, true, 'call centre');

    const suspect = mergesOnQuarantinedIdentifiers(db);
    expect(suspect.map((entry) => entry.id)).toEqual([outcome.result?.mergeLogId]);
  });
});

/* -------------------------------------------------------------------------- */
/* The merge log                                                              */
/* -------------------------------------------------------------------------- */

describe('every merge is explainable', () => {
  it('records the deciding signal, the score and the full signal list', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Novak Komerc', { cityId: 'nis' }), NAVIDIKU);

    const outcome = mergeLeads(db, a.leadId, b.leadId, {
      signal: 'phone',
      signalValue: '+381641112233',
      score: 0.95,
      signals: [
        {
          kind: 'phone',
          value: '+381641112233',
          weight: 0.95,
          role: 'decisive',
          detail: 'both publish +381641112233',
        },
      ],
      actor: 'pipeline',
    });

    const entry = getMergeLogEntry(db, outcome.result?.mergeLogId ?? 0);
    expect(entry?.signal).toBe('phone');
    expect(entry?.signalValue).toBe('+381641112233');
    expect(entry?.score).toBe(0.95);
    expect(entry?.actor).toBe('pipeline');
    expect(JSON.parse(entry?.signals ?? '[]')).toHaveLength(1);
    expect(entry?.survivingLeadId).toBe(a.leadId);
    expect(entry?.mergedLeadId).toBe(b.leadId);
  });

  it('closes the pending review pairs that pointed at the merged-away lead', () => {
    const a = upsertLead(db, lead('Fasade Novak', { cityId: 'nis' }), PORTAL);
    const b = upsertLead(db, lead('Fasade Novak Komerc', { cityId: 'nis' }), NAVIDIKU);
    const c = upsertLead(db, lead('Fasade Novakovic', { cityId: 'nis' }), OGLASI);

    upsertMergeCandidate(db, {
      leadAId: b.leadId,
      leadBId: c.leadId,
      score: 0.6,
      topSignal: 'name_city',
      signalValue: 'fasade novak',
      signals: '[]',
    });
    expect(pendingMergeCandidates(db)).toHaveLength(1);

    mergeLeads(db, a.leadId, b.leadId, PHONE_REASON);
    // The pair no longer describes two live rows; the sweep re-proposes it
    // against the survivor with the fuller record.
    expect(pendingMergeCandidates(db)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Undoing a merge                                                            */
/* -------------------------------------------------------------------------- */

describe('unmergeLeads', () => {
  function twoLeads() {
    const a = upsertLead(
      db,
      lead('Fasade Novak', {
        cityId: 'nis',
        phones: [{ e164: '+381641112233', raw: '064/111-2233' }],
      }),
      PORTAL,
    );
    const b = upsertLead(
      db,
      lead('Fasade Novakovic', {
        cityId: 'nis',
        phones: [{ e164: '+381649998877', raw: '064/999-8877' }],
        contacts: [{ kind: 'email', value: 'novakovic@fasade.rs' }],
        description: 'Termo fasade i izolacija.',
      }),
      NAVIDIKU,
    );
    return { a: a.leadId, b: b.leadId };
  }

  it('puts every moved row back where it came from', () => {
    const { a, b } = twoLeads();
    const before = {
      a: toLeadRecord(db, a),
      b: toLeadRecord(db, b),
    };

    const outcome = mergeLeads(db, a, b, PHONE_REASON);
    expect(distinctPhones(db, a)).toHaveLength(2);

    unmergeLeads(db, outcome.result?.mergeLogId ?? 0, 'wrong: two businesses');

    expect(toLeadRecord(db, a)?.phones).toEqual(before.a?.phones);
    expect(toLeadRecord(db, b)?.phones).toEqual(before.b?.phones);
    expect(toLeadRecord(db, b)?.emails).toEqual(before.b?.emails);
    expect(getLead(db, b)?.mergedIntoId).toBeNull();
    expect(resolveLead(db, b)?.id).toBe(b);
  });

  it('re-grades both leads, so neither keeps a score from the union', () => {
    const { a, b } = twoLeads();
    const outcome = mergeLeads(db, a, b, PHONE_REASON);
    const mergedScore = getLead(db, a)?.leadScore ?? 0;

    const unmerged = unmergeLeads(db, outcome.result?.mergeLogId ?? 0);

    expect(unmerged.regraded).toHaveLength(2);
    // The survivor lost a phone, an email and a source: it must score lower.
    expect(getLead(db, a)?.leadScore).toBeLessThan(mergedScore);
  });

  it('records the revert on the merge log instead of deleting the row', () => {
    const { a, b } = twoLeads();
    const outcome = mergeLeads(db, a, b, PHONE_REASON);
    const mergeLogId = outcome.result?.mergeLogId ?? 0;

    unmergeLeads(db, mergeLogId, 'two branches, not one business');

    const entry = getMergeLogEntry(db, mergeLogId);
    expect(entry?.revertedAt).toBeInstanceOf(Date);
    expect(entry?.revertNote).toBe('two branches, not one business');
  });

  it('refuses to be run twice', () => {
    const { a, b } = twoLeads();
    const outcome = mergeLeads(db, a, b, PHONE_REASON);
    const mergeLogId = outcome.result?.mergeLogId ?? 0;

    unmergeLeads(db, mergeLogId);
    expect(() => unmergeLeads(db, mergeLogId)).toThrow(/already reverted/);
  });

  it('refuses when the survivor has since been merged onward', () => {
    const { a, b } = twoLeads();
    const c = upsertLead(db, lead('Fasade Novak Trade', { cityId: 'nis' }), OGLASI);

    const first = mergeLeads(db, a, b, PHONE_REASON);
    mergeLeads(db, c.leadId, a, PHONE_REASON);

    // The snapshot describes rows that have moved on. Undo the later merge first.
    expect(() => unmergeLeads(db, first.result?.mergeLogId ?? 0)).toThrow(/merged into/);
  });

  it('lets a chain be undone newest first', () => {
    const { a, b } = twoLeads();
    const c = upsertLead(db, lead('Fasade Novak Trade', { cityId: 'nis' }), OGLASI);

    const first = mergeLeads(db, a, b, PHONE_REASON);
    const second = mergeLeads(db, c.leadId, a, PHONE_REASON);

    unmergeLeads(db, second.result?.mergeLogId ?? 0);
    unmergeLeads(db, first.result?.mergeLogId ?? 0);

    for (const id of [a, b, c.leadId]) {
      expect(getLead(db, id)?.mergedIntoId).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Which side survives                                                        */
/* -------------------------------------------------------------------------- */

describe('chooseSurvivor', () => {
  it('keeps the record that already carries more', () => {
    const thin = leadRecord({ id: 1, name: 'Fasade Novak', phones: ['+381641112233'] });
    const full = leadRecord({
      id: 2,
      name: 'Fasade Novak d.o.o.',
      cityId: 'nis',
      phones: ['+381641112233', '+381189998877'],
      emails: ['info@fasadenovak.rs'],
      sourceIds: ['portal-srbija', 'navidiku-rs'],
    });

    expect(chooseSurvivor(thin, full).survivor.id).toBe(2);
    expect(chooseSurvivor(full, thin).survivor.id).toBe(2);
  });

  it('breaks a tie on which was seen first', () => {
    const older = leadRecord({ id: 7, name: 'Fasade Novak', firstSeenAt: new Date('2026-01-01') });
    const newer = leadRecord({ id: 2, name: 'Fasade Novak', firstSeenAt: new Date('2026-06-01') });
    expect(chooseSurvivor(newer, older).survivor.id).toBe(7);
  });

  it('falls back to the lower id when nothing else separates them', () => {
    const a = leadRecord({ id: 2, name: 'Fasade Novak' });
    const b = leadRecord({ id: 9, name: 'Fasade Novak' });
    expect(chooseSurvivor(b, a).survivor.id).toBe(2);
  });
});

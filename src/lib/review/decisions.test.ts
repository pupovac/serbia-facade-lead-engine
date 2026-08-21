/**
 * The test this whole module exists for: **a human decision is never silently
 * overwritten by a later crawl.**
 *
 * Each case re-runs the crawl path — the same `upsertLead` an adapter calls,
 * with the same source and a *different* value — after a reviewer has decided,
 * and asserts the reviewer still wins. The cases are the ones that actually
 * happen: a directory republishing an old company name, a second directory
 * publishing a different address, a re-classification sweep, and a pair a
 * reviewer has already rejected coming back round on the next sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  applyGrading,
  getLead,
  leadPhoneClaims,
  upsertLead,
  upsertMergeCandidate,
  upsertSource,
  type Provenance,
} from '../db/repo.js';
import { pendingSuggestions, recordSuggestion } from '../db/suggestions.js';
import { leadFieldValues, leads, mergeCandidates, mergeLog } from '../db/schema.js';
import { foldForComparison } from '../text/fold.js';
import {
  REVIEWER_SOURCE_ID,
  acceptSuggestion,
  editLeadField,
  humanFieldEdits,
  mergePair,
  overriddenHumanEdits,
  rejectPair,
  rejectSuggestion,
  setLeadStatus,
  undoMerge,
} from './decisions.js';
import { leadDetail, mergeQueue, suggestionQueue } from './detail.js';

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasade-petrovic',
};
const GRADJEVINARSTVO: Provenance = {
  sourceId: 'gradjevinarstvo-rs',
  sourceUrl: 'https://www.gradjevinarstvo.rs/firme/1139/fasade-petrovic',
};

function seedLead(name: string, overrides: Record<string, unknown> = {}): number {
  return upsertLead(
    db,
    {
      name,
      nameNormalized: foldForComparison(name),
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      cityRaw: 'Novi Sad',
      ...overrides,
    },
    PORTAL,
  ).leadId;
}

beforeEach(() => {
  db = openTestDatabase();
  for (const [id, name] of [
    ['portal-srbija', 'Portal Srbija'],
    ['gradjevinarstvo-rs', 'Gradjevinarstvo.rs'],
    ['website-enrichment', 'Website contact-page enrichment'],
  ] as const) {
    upsertSource(db, { id, name, url: `https://${id}.rs`, category: 'test' });
  }
});

afterEach(() => {
  closeDatabase(db);
});

/* -------------------------------------------------------------------------- */
/* The one that matters                                                       */
/* -------------------------------------------------------------------------- */

describe('a human edit survives a subsequent crawl', () => {
  it('keeps the reviewer’s name when the directory republishes the old one', () => {
    const leadId = seedLead('FASADE PETROVIC DOO', {
      phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' as const }],
    });

    editLeadField(db, {
      leadId,
      field: 'name',
      value: 'Fasade Petrović d.o.o.',
      reviewer: 'alex',
    });
    expect(getLead(db, leadId)?.name).toBe('Fasade Petrović d.o.o.');

    // The next crawl of the same page, weeks later, still publishing the
    // all-caps spelling — and matching on the phone number, as it would.
    upsertLead(
      db,
      {
        name: 'FASADE PETROVIC DOO',
        nameNormalized: foldForComparison('FASADE PETROVIC DOO'),
        phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
      },
      { ...PORTAL, seenAt: new Date('2026-09-01') },
    );

    expect(getLead(db, leadId)?.name).toBe('Fasade Petrović d.o.o.');
  });

  it('keeps the reviewer’s address when a second directory publishes another', () => {
    const leadId = seedLead('Termo Dom', { address: 'Bulevar oslobođenja 1' });

    editLeadField(db, {
      leadId,
      field: 'address',
      value: 'Bulevar oslobođenja 100a',
      reviewer: 'alex',
    });

    upsertLead(
      db,
      {
        name: 'Termo Dom',
        nameNormalized: foldForComparison('Termo Dom'),
        cityId: 'novi-sad',
        address: 'Bulevar oslobodjenja 1',
        leadId,
      },
      { ...GRADJEVINARSTVO, seenAt: new Date('2026-09-01') },
      { matching: 'caller' },
    );

    expect(getLead(db, leadId)?.address).toBe('Bulevar oslobođenja 100a');
  });

  it('records the crawl’s value as a conflict rather than discarding it', () => {
    const leadId = seedLead('Stovarište Marković', { address: 'Cara Dušana 12' });
    editLeadField(db, { leadId, field: 'address', value: 'Cara Dušana 12b', reviewer: 'alex' });

    upsertLead(
      db,
      {
        name: 'Stovarište Marković',
        nameNormalized: foldForComparison('Stovarište Marković'),
        address: 'Cara Dusana 12',
        leadId,
      },
      { ...GRADJEVINARSTVO, seenAt: new Date('2026-09-01') },
      { matching: 'caller' },
    );

    const claims = db
      .select()
      .from(leadFieldValues)
      .where(eq(leadFieldValues.leadId, leadId))
      .all()
      .filter((claim) => claim.field === 'address');

    // Three claims, one current, and the current one is the human's.
    expect(claims.map((c) => c.value).sort()).toEqual([
      'Cara Dusana 12',
      'Cara Dušana 12',
      'Cara Dušana 12b',
    ]);
    const current = claims.filter((c) => c.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]?.value).toBe('Cara Dušana 12b');
    expect(current[0]?.sourceId).toBe(REVIEWER_SOURCE_ID);
  });

  it('carries provenance saying a human made the change', () => {
    const leadId = seedLead('Izolacija Plus');
    editLeadField(db, { leadId, field: 'address', value: 'Kralja Petra 5', reviewer: 'alex' });

    const edits = humanFieldEdits(db, leadId);
    const address = edits.find((claim) => claim.field === 'address');
    expect(address?.sourceId).toBe(REVIEWER_SOURCE_ID);
    expect(address?.sourceUrl).toBe(`internal://review/leads/${leadId}`);
    expect(address?.isCurrent).toBe(true);
    expect(getLead(db, leadId)?.reviewedAt).toBeInstanceOf(Date);
  });

  it('keeps a human classification through a re-crawl that classifies it differently', () => {
    const leadId = seedLead('Fasaderski Radovi Nikolić');
    editLeadField(db, {
      leadId,
      field: 'classification',
      value: 'FACADE_CONTRACTOR',
      reviewer: 'alex',
    });

    upsertLead(
      db,
      {
        name: 'Fasaderski Radovi Nikolić',
        nameNormalized: foldForComparison('Fasaderski Radovi Nikolić'),
        classification: 'CONSTRUCTION_MATERIAL_STORE',
        classificationConfidence: 0.7,
        leadId,
      },
      { ...GRADJEVINARSTVO, seenAt: new Date('2026-09-01') },
      { matching: 'caller' },
    );

    expect(getLead(db, leadId)?.classification).toBe('FACADE_CONTRACTOR');
  });

  it('leaves the review status and note alone when a crawl re-sees the lead', () => {
    const leadId = seedLead('Gradnja Jovanović');
    setLeadStatus(db, {
      leadId,
      status: 'approved',
      note: 'called, wants a sample',
      reviewer: 'alex',
    });

    upsertLead(
      db,
      {
        name: 'Gradnja Jovanović',
        nameNormalized: foldForComparison('Gradnja Jovanović'),
        description: 'fasaderski radovi',
        leadId,
      },
      { ...GRADJEVINARSTVO, seenAt: new Date('2026-09-01') },
      { matching: 'caller' },
    );
    applyGrading(db, leadId, {
      classification: 'UNCLASSIFIED',
      classificationConfidence: 0.1,
      relevanceScore: 0,
      contactabilityScore: 40,
      leadScore: 0,
    });

    const after = getLead(db, leadId);
    expect(after?.status).toBe('approved');
    expect(after?.reviewNote).toContain('called, wants a sample');
    expect(after?.reviewNote).toContain('reviewer:alex');
  });

  it('surfaces the divergence when a re-classification sweep overwrites a human label', () => {
    const leadId = seedLead('Fasade Ilić');
    editLeadField(db, {
      leadId,
      field: 'classification',
      value: 'FACADE_CONTRACTOR',
      reviewer: 'alex',
    });
    expect(overriddenHumanEdits(db, leadId)).toHaveLength(0);

    // `applyGrading` writes `leads.classification` unconditionally and does not
    // read `lead_field_values`. The human's claim survives; the column does not.
    applyGrading(db, leadId, {
      classification: 'UNCLASSIFIED',
      classificationConfidence: 0.2,
      relevanceScore: 0,
      contactabilityScore: 30,
      leadScore: 0,
    });

    const overridden = overriddenHumanEdits(db, leadId);
    expect(overridden.map((claim) => claim.field)).toEqual(['classification']);
    expect(overridden[0]?.value).toBe('FACADE_CONTRACTOR');
  });
});

/* -------------------------------------------------------------------------- */
/* Merge and reject                                                           */
/* -------------------------------------------------------------------------- */

function seedPair(): { a: number; b: number; candidateId: number } {
  const a = seedLead('AS Inženjering', {
    phones: [{ e164: '+381211234567', raw: '021/123-4567', type: 'landline' as const }],
  });
  const b = upsertLead(
    db,
    {
      name: 'A & S Inženjering',
      nameNormalized: foldForComparison('A & S Inženjering'),
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      cityRaw: 'Novi Sad',
      address: 'Vladimira Popovića 6',
      phones: [{ e164: '+381219876543', raw: '021/987-6543', type: 'landline' }],
    },
    GRADJEVINARSTVO,
    { matching: 'caller' },
  ).leadId;

  const candidate = upsertMergeCandidate(db, {
    leadAId: a,
    leadBId: b,
    score: 0.64,
    topSignal: 'name_city',
    signalValue: 'as inzenjering',
    signals: JSON.stringify([{ signal: 'name_city', score: 0.64 }]),
  });
  return { a, b, candidateId: candidate.id };
}

describe('merge and reject', () => {
  it('merges transactionally, writes merge_log and moves every child', () => {
    const { a, b, candidateId } = seedPair();

    const result = mergePair(db, { candidateId, survivingLeadId: a, reviewer: 'alex' });

    expect(result.survivingLeadId).toBe(a);
    expect(getLead(db, b)?.mergedIntoId).toBe(a);
    expect(
      leadPhoneClaims(db, a)
        .map((p) => p.e164)
        .sort(),
    ).toEqual(['+381211234567', '+381219876543']);
    expect(leadPhoneClaims(db, b)).toHaveLength(0);

    const log = db.select().from(mergeLog).where(eq(mergeLog.id, result.mergeLogId)).get();
    expect(log?.signal).toBe('manual');
    expect(log?.actor).toBe('reviewer:alex');
    expect(log?.snapshot).toBeTruthy();

    const candidate = db
      .select()
      .from(mergeCandidates)
      .where(eq(mergeCandidates.id, candidateId))
      .get();
    expect(candidate?.status).toBe('merged');
    expect(candidate?.mergeLogId).toBe(result.mergeLogId);
    expect(candidate?.resolvedBy).toBe('reviewer:alex');
  });

  it('is reversible: undoMerge restores both leads and reopens the pair', () => {
    const { a, b, candidateId } = seedPair();
    const result = mergePair(db, { candidateId, survivingLeadId: a, reviewer: 'alex' });

    undoMerge(db, result.mergeLogId, 'alex', 'two different companies');

    expect(getLead(db, b)?.mergedIntoId).toBeNull();
    expect(leadPhoneClaims(db, b).map((p) => p.e164)).toEqual(['+381219876543']);
    expect(leadPhoneClaims(db, a).map((p) => p.e164)).toEqual(['+381211234567']);
    const candidate = db
      .select()
      .from(mergeCandidates)
      .where(eq(mergeCandidates.id, candidateId))
      .get();
    expect(candidate?.status).toBe('pending');
  });

  it('rolls the whole decision back when any part of it fails', () => {
    const { a, candidateId } = seedPair();
    const before = db.select().from(mergeLog).all().length;

    // A lead that is not in the pair: the merge must not happen at all.
    expect(() =>
      mergePair(db, { candidateId, survivingLeadId: a + 999, reviewer: 'alex' }),
    ).toThrow();

    expect(db.select().from(mergeLog).all()).toHaveLength(before);
    expect(
      db.select().from(mergeCandidates).where(eq(mergeCandidates.id, candidateId)).get()?.status,
    ).toBe('pending');
  });

  it('a rejected pair is never re-proposed by a later sweep', () => {
    const { a, b, candidateId } = seedPair();
    rejectPair(db, { candidateId, reviewer: 'alex' });

    expect(mergeQueue(db).total).toBe(0);

    // The next dedup sweep finds the same pair again, with the same evidence.
    const again = upsertMergeCandidate(db, {
      leadAId: a,
      leadBId: b,
      score: 0.64,
      topSignal: 'name_city',
      signalValue: 'as inzenjering',
      signals: '[]',
    });
    expect(again.status).toBe('rejected');
    expect(mergeQueue(db).total).toBe(0);
  });

  it('refuses to merge a pair a human has already decided', () => {
    const { a, candidateId } = seedPair();
    mergePair(db, { candidateId, survivingLeadId: a, reviewer: 'alex' });
    expect(() => mergePair(db, { candidateId, survivingLeadId: a, reviewer: 'alex' })).toThrow(
      /already merged/,
    );
  });

  it('shows the merge in the survivor’s history on the detail page', () => {
    const { a, b, candidateId } = seedPair();
    mergePair(db, { candidateId, survivingLeadId: a, reviewer: 'alex' });

    const detail = leadDetail(db, a);
    expect(detail?.mergeHistory).toHaveLength(1);
    expect(detail?.mergeHistory[0]?.mergedLeadId).toBe(b);
    expect(detail?.mergeHistory[0]?.actor).toBe('reviewer:alex');

    // The tombstone still resolves — every id ever handed out keeps working.
    expect(leadDetail(db, b)?.resolvesTo?.id).toBe(a);
  });
});

/* -------------------------------------------------------------------------- */
/* Enrichment suggestions                                                     */
/* -------------------------------------------------------------------------- */

describe('enrichment suggestions', () => {
  function seedSuggestion(kind: 'phone' | 'website'): { leadId: number; id: number } {
    const leadId = seedLead('Saint-Gobain Srbija');
    const { id } = recordSuggestion(db, {
      leadId,
      kind,
      value: kind === 'phone' ? '+381113149684' : 'https://saint-gobain.rs',
      valueRaw: kind === 'phone' ? '011 314 96 84' : 'https://saint-gobain.rs',
      sourceUrl: 'https://www.saint-gobain.rs/kontakt',
      origin: 'discovered',
      confidence: 0.5,
      rule: 'corroboration_without_name',
      reason: 'two landlines in the same subscriber range, but the names do not match',
      evidence: '[]',
    });
    return { leadId, id };
  }

  it('accepting writes the value onto the lead with the reviewer as provenance', () => {
    const { leadId, id } = seedSuggestion('phone');
    acceptSuggestion(db, { suggestionId: id, reviewer: 'alex' });

    const claims = leadPhoneClaims(db, leadId);
    const accepted = claims.find((claim) => claim.e164 === '+381113149684');
    expect(accepted?.sourceId).toBe(REVIEWER_SOURCE_ID);
    expect(accepted?.sourceUrl).toBe('https://www.saint-gobain.rs/kontakt');
    expect(suggestionQueue(db).total).toBe(0);
  });

  it('rejecting is remembered, so a re-run does not re-open it', () => {
    const { id } = seedSuggestion('website');
    rejectSuggestion(db, { suggestionId: id, reviewer: 'alex' });
    expect(suggestionQueue(db).total).toBe(0);

    // The enrichment crawler reads the same page again next month.
    const { leadId } = seedSuggestion('website');
    recordSuggestion(db, {
      leadId,
      kind: 'website',
      value: 'https://saint-gobain.rs',
      sourceUrl: 'https://www.saint-gobain.rs/kontakt',
      origin: 'discovered',
      confidence: 0.9,
      rule: 'corroboration_without_name',
      reason: 'one more corroborating signal',
      evidence: '[]',
    });
    expect(pendingSuggestions(db, { status: 'rejected' })).toHaveLength(1);
  });

  it('refuses to accept a suggestion twice', () => {
    const { id } = seedSuggestion('phone');
    acceptSuggestion(db, { suggestionId: id, reviewer: 'alex' });
    expect(() => acceptSuggestion(db, { suggestionId: id, reviewer: 'alex' })).toThrow(
      /already accepted/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('review status', () => {
  it('stamps who decided and when', () => {
    const leadId = seedLead('Munja Cop');
    setLeadStatus(db, { leadId, status: 'reviewed', reviewer: 'alex' });
    const row = db.select().from(leads).where(eq(leads.id, leadId)).get();
    expect(row?.status).toBe('reviewed');
    expect(row?.reviewNote).toContain('reviewer:alex');
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });
});

/**
 * Classify → score → persist, against a migrated in-memory database.
 *
 * This is the path the crawler actually walks, and the thing it proves is that
 * the evidence survives the write: a label in the database that cannot be
 * explained is a label a reviewer will overrule on instinct.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyLead, decidingNet } from '../classify/index.js';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  applyGrading,
  distinctPhones,
  getLead,
  leadContactClaims,
  leadSourceRows,
  upsertLead,
} from '../db/repo.js';
import { upsertSource } from '../db/repo.js';
import { foldForComparison } from '../text/fold.js';
import { scoreLead } from './score.js';
import { toScoreInput } from './from-db.js';
import { toGrading } from './grading.js';

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
  upsertSource(db, {
    id: 'portal-srbija',
    name: 'Portal Srbija',
    url: 'https://www.portal-srbija.com/',
    category: 'test',
  });
});

afterEach(() => {
  closeDatabase(db);
});

const PROVENANCE = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/termo-izolacija-zvucna-izolacija',
  seenAt: new Date('2026-08-19T12:00:00Z'),
};

describe('classify → score → persist', () => {
  it('writes the label, its confidence, its evidence and the score breakdown', () => {
    const name = 'Fasaderski radovi Veljko';
    const description = 'Izrada demit fasada, malterisanje, molersko-fasaderski radovi.';
    const classification = classifyLead({ name, description });
    expect(classification.label).toBe('FACADE_CONTRACTOR');

    const { leadId } = upsertLead(
      db,
      {
        name,
        nameNormalized: foldForComparison(name),
        description,
        cityId: 'beograd',
        municipalityId: 'beograd',
        cityRaw: 'Beograd',
        phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
      },
      PROVENANCE,
    );

    const stored = getLead(db, leadId);
    expect(stored).toBeDefined();
    const score = scoreLead({
      ...toScoreInput({
        lead: stored!,
        phones: distinctPhones(db, leadId),
        contacts: leadContactClaims(db, leadId),
        sources: leadSourceRows(db, leadId),
        city: { confidence: 1, matchedVia: 'exact' },
        now: new Date('2026-08-20T12:00:00Z'),
      }),
      // The label this run just computed, not the `UNCLASSIFIED` default still
      // on the row — the pipeline scores the verdict it is about to write.
      classification: {
        label: classification.label,
        confidence: classification.confidence,
        evidenceNet: decidingNet(classification),
      },
    });

    applyGrading(
      db,
      leadId,
      toGrading(
        {
          label: classification.label,
          confidence: classification.confidence,
          evidence: JSON.stringify({
            evidence: classification.evidence,
            suppressed: classification.suppressed,
            contractor: classification.contractor,
            store: classification.store,
            reason: classification.reason,
          }),
        },
        score,
      ),
    );

    const graded = getLead(db, leadId);
    expect(graded?.classification).toBe('FACADE_CONTRACTOR');
    expect(graded?.classificationConfidence).toBe(classification.confidence);
    expect(graded?.leadScore).toBe(score.score);
    expect(graded?.relevanceScore).toBe(score.relevance);
    expect(graded?.contactabilityScore).toBe(score.contactability);
    expect(graded?.contactabilityScore).toBeGreaterThan(50);
    // A confirmed contractor with a mobile and a city clears the bar on both
    // axes, so the derived key is high too.
    expect(graded?.leadScore).toBeGreaterThan(40);

    const evidence = JSON.parse(graded?.classificationEvidence ?? '{}') as {
      evidence: { signalId: string; matched: string }[];
      reason: string;
    };
    expect(evidence.evidence.map((e) => e.signalId)).toContain('contractor.fasader');
    expect(evidence.reason).toBe(classification.reason);

    const breakdown = JSON.parse(graded?.scoreBreakdown ?? '[]') as {
      id: string;
      points: number;
    }[];
    expect(breakdown.reduce((sum, c) => sum + c.points, 0)).toBeCloseTo(score.contactability, 0);

    const relevance = JSON.parse(graded?.relevanceBreakdown ?? '[]') as {
      id: string;
      points: number;
    }[];
    expect(relevance.map((c) => c.id)).toStrictEqual(['label', 'confidence', 'evidence']);
    expect(relevance.reduce((sum, c) => sum + c.points, 0)).toBeCloseTo(score.relevance, 0);
  });

  it('re-grading overwrites the previous verdict rather than filling a gap', () => {
    const name = 'Termo Nešto';
    const { leadId } = upsertLead(
      db,
      { name, nameNormalized: foldForComparison(name) },
      PROVENANCE,
    );

    applyGrading(db, leadId, {
      classification: 'UNCLASSIFIED',
      classificationConfidence: 0.9,
      relevanceScore: 0,
      contactabilityScore: 4,
      leadScore: 0,
    });
    expect(getLead(db, leadId)?.classification).toBe('UNCLASSIFIED');

    // A later crawl found the company's own site, which says what it does.
    applyGrading(db, leadId, {
      classification: 'CONSTRUCTION_MATERIAL_STORE',
      classificationConfidence: 0.7,
      classificationEvidence: '{"reason":"stovariste in website text"}',
      relevanceScore: 72,
      contactabilityScore: 61,
      leadScore: 44,
      scoreBreakdown: '[]',
    });

    const regraded = getLead(db, leadId);
    expect(regraded?.classification).toBe('CONSTRUCTION_MATERIAL_STORE');
    expect(regraded?.classificationConfidence).toBe(0.7);
    expect(regraded?.relevanceScore).toBe(72);
    expect(regraded?.contactabilityScore).toBe(61);
    expect(regraded?.leadScore).toBe(44);
    expect(regraded?.classificationEvidence).toContain('stovariste');
  });

  it('scores a phone-only lead read straight back out of the database', () => {
    const name = 'Moler Dragomir';
    const { leadId } = upsertLead(
      db,
      {
        name,
        nameNormalized: foldForComparison(name),
        phones: [{ e164: '+381691484637', raw: '069 1484637', type: 'mobile' }],
      },
      PROVENANCE,
    );

    const stored = getLead(db, leadId);
    const score = scoreLead(
      toScoreInput({
        lead: stored!,
        phones: distinctPhones(db, leadId),
        contacts: leadContactClaims(db, leadId),
        sources: leadSourceRows(db, leadId),
        now: new Date('2026-08-20T12:00:00Z'),
      }),
    );

    // No email, no site, no city — still a number someone can dial, so
    // contactability stands on its own.
    expect(score.contactability).toBeGreaterThanOrEqual(40);
    expect(score.capped).toBe(false);
    // And it is still unclassified, so it is not a lead yet and the derived
    // key says so rather than ranking it on reachability alone.
    expect(stored?.classification).toBe('UNCLASSIFIED');
    expect(score.relevance).toBe(0);
    expect(score.score).toBe(0);
  });
});

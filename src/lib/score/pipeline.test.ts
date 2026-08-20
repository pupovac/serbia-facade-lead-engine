/**
 * Classify → score → persist, against a migrated in-memory database.
 *
 * This is the path the crawler actually walks, and the thing it proves is that
 * the evidence survives the write: a label in the database that cannot be
 * explained is a label a reviewer will overrule on instinct.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyLead } from '../classify/index.js';
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
    const score = scoreLead(
      toScoreInput({
        lead: stored!,
        phones: distinctPhones(db, leadId),
        contacts: leadContactClaims(db, leadId),
        sources: leadSourceRows(db, leadId),
        city: { confidence: 1, matchedVia: 'exact' },
        now: new Date('2026-08-20T12:00:00Z'),
      }),
    );

    applyGrading(db, leadId, {
      classification: classification.label,
      classificationConfidence: classification.confidence,
      classificationEvidence: JSON.stringify({
        evidence: classification.evidence,
        suppressed: classification.suppressed,
        contractor: classification.contractor,
        store: classification.store,
        reason: classification.reason,
      }),
      leadScore: score.score,
      scoreBreakdown: JSON.stringify(score.components),
    });

    const graded = getLead(db, leadId);
    expect(graded?.classification).toBe('FACADE_CONTRACTOR');
    expect(graded?.classificationConfidence).toBe(classification.confidence);
    expect(graded?.leadScore).toBe(score.score);
    expect(graded?.leadScore).toBeGreaterThan(50);

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
    expect(breakdown.reduce((sum, c) => sum + c.points, 0)).toBeCloseTo(score.score, 0);
  });

  it('re-grading overwrites the previous verdict rather than filling a gap', () => {
    const name = 'Termo Nešto';
    const { leadId } = upsertLead(
      db,
      { name, nameNormalized: foldForComparison(name) },
      PROVENANCE,
    );

    applyGrading(db, leadId, {
      classification: 'UNKNOWN',
      classificationConfidence: 0.9,
      leadScore: 4,
    });
    expect(getLead(db, leadId)?.classification).toBe('UNKNOWN');

    // A later crawl found the company's own site, which says what it does.
    applyGrading(db, leadId, {
      classification: 'CONSTRUCTION_MATERIAL_STORE',
      classificationConfidence: 0.7,
      classificationEvidence: '{"reason":"stovariste in website text"}',
      leadScore: 61,
      scoreBreakdown: '[]',
    });

    const regraded = getLead(db, leadId);
    expect(regraded?.classification).toBe('CONSTRUCTION_MATERIAL_STORE');
    expect(regraded?.classificationConfidence).toBe(0.7);
    expect(regraded?.leadScore).toBe(61);
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

    // No email, no site, no city, UNKNOWN classification — still a usable lead.
    expect(score.score).toBeGreaterThanOrEqual(40);
    expect(score.capped).toBe(false);
  });
});

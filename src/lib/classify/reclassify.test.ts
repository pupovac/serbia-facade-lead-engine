/**
 * Re-classification tests.
 *
 * The thing worth pinning here is not the classifier — that has its own suite —
 * but what the classifier is *shown*: a stored lead's categories live only
 * inside `raw_records.payload`, and a lead five sources agree on has five of
 * them. A rebuild that reads the lead row alone silently reclassifies half the
 * corpus on a fraction of its evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import { attachSource, saveRawRecord, upsertLead, upsertSource } from '../db/repo.js';
import { foldForComparison } from '../text/fold.js';
import { leadClassificationInput, reclassifyCorpus } from './reclassify.js';

let db: Db;

const OVERTURE = {
  sourceId: 'overture-places',
  sourceUrl: 'https://overturemaps.example/#gers-1',
} as const;
const PORTAL = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/zavrsni-radovi-restauracije',
} as const;

beforeEach(() => {
  db = openTestDatabase();
  for (const id of ['overture-places', 'portal-srbija'] as const) {
    upsertSource(db, { id, name: id, url: `https://${id}.example`, category: 'test' });
  }
});

afterEach(() => {
  closeDatabase(db);
});

/** A lead with one stored payload behind it, the way the pipeline writes them. */
function seed(
  name: string,
  payload: Record<string, unknown>,
  provenance: { sourceId: string; sourceUrl: string },
  lead: Record<string, unknown> = {},
): number {
  const { leadId } = upsertLead(
    db,
    { name, nameNormalized: foldForComparison(name), ...lead },
    provenance,
  );
  const raw = saveRawRecord(db, {
    sourceId: provenance.sourceId,
    sourceUrl: provenance.sourceUrl,
    payload: JSON.stringify(payload),
    leadId,
  });
  attachSource(db, leadId, { ...provenance, rawRecordId: raw.id });
  return leadId;
}

describe('leadClassificationInput', () => {
  it('recovers the source categories, which are stored nowhere else', () => {
    const leadId = seed(
      'Ćorić Fasade',
      { categories: ['building_or_construction_service'] },
      OVERTURE,
    );
    expect(leadClassificationInput(db, leadId)).toStrictEqual({
      name: 'Ćorić Fasade',
      categories: ['building_or_construction_service'],
    });
  });

  it('unwraps the enrichment crawler’s `{ raw, verdict }` envelope', () => {
    const leadId = seed(
      'Almont',
      {
        raw: { categories: ['contractor'], description: 'Fasaderski radovi.' },
        verdict: { tier: 'merge' },
      },
      OVERTURE,
    );
    const input = leadClassificationInput(db, leadId);
    expect(input?.categories).toStrictEqual(['contractor']);
    expect(input?.description).toBe('Fasaderski radovi.');
  });

  it('unions every source’s categories and descriptions onto the merged lead', () => {
    const leadId = seed(
      'S.R.M.A.',
      { categories: ['building_or_construction_service'] },
      OVERTURE,
      {
        description: 'Boje i lakovi, fasadni materijali.',
      },
    );
    const raw = saveRawRecord(db, {
      sourceId: PORTAL.sourceId,
      sourceUrl: PORTAL.sourceUrl,
      payload: JSON.stringify({
        categories: ['Stovarišta'],
        description: 'Suva gradnja, malteri.',
      }),
      leadId,
    });
    attachSource(db, leadId, { ...PORTAL, rawRecordId: raw.id });

    const input = leadClassificationInput(db, leadId);
    expect(input?.categories).toStrictEqual(['building_or_construction_service', 'Stovarišta']);
    expect(input?.description).toContain('Boje i lakovi');
    expect(input?.description).toContain('Suva gradnja');
  });

  it('survives a payload that no longer parses', () => {
    const leadId = seed('Neko preduzeće', { categories: ['contractor'] }, OVERTURE);
    const raw = saveRawRecord(db, {
      sourceId: PORTAL.sourceId,
      sourceUrl: PORTAL.sourceUrl,
      payload: '{ not json',
      leadId,
    });
    attachSource(db, leadId, { ...PORTAL, rawRecordId: raw.id });
    expect(leadClassificationInput(db, leadId)?.categories).toStrictEqual(['contractor']);
  });

  it('returns undefined for a lead that does not exist', () => {
    expect(leadClassificationInput(db, 9999)).toBeUndefined();
  });
});

describe('reclassifyCorpus', () => {
  it('reports the label that moved, and leaves the database alone', () => {
    const leadId = seed(
      'Ćorić Fasade',
      { categories: ['building_or_construction_service'] },
      OVERTURE,
    );

    const report = reclassifyCorpus(db);
    expect(report.total).toBe(1);
    expect(report.before).toMatchObject({ UNKNOWN: 1, FACADE_CONTRACTOR: 0 });
    expect(report.after).toMatchObject({ UNKNOWN: 0, FACADE_CONTRACTOR: 1 });
    expect(report.transitions).toStrictEqual({ 'UNKNOWN→FACADE_CONTRACTOR': 1 });
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]?.leadId).toBe(leadId);

    // Dry by construction: nothing is written until `regradeLead` is called.
    const again = reclassifyCorpus(db);
    expect(again.before).toMatchObject({ UNKNOWN: 1 });
  });

  it('carries the evidence trail, so a reviewer can argue with the number', () => {
    seed('Ćorić Fasade', {}, OVERTURE);
    const [entry] = reclassifyCorpus(db).all;
    expect(entry?.result.evidence.map((e) => e.signalId)).toContain('contractor.fasada');
    expect(entry?.result.reason).not.toBe('');
  });
});

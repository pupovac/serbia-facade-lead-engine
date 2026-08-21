/**
 * The dashboard's arithmetic.
 *
 * Coverage is the figure most worth guarding: "145 of 145 municipalities" is
 * only meaningful if the denominator is the geo dataset and the zero rows are
 * present. A coverage table that lists only what was found cannot show a gap,
 * which is the one thing the dashboard is for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  finishRun,
  startRun,
  upsertLead,
  upsertMergeCandidate,
  upsertSource,
  type LeadInput,
  type Provenance,
} from '../db/repo.js';
import { municipalities } from '../geo.js';
import { foldForComparison } from '../text/fold.js';
import { dashboardStats, growth, municipalityCoverage, sourceYield } from './dashboard.js';

let db: Db;

const PORTAL: Provenance = { sourceId: 'portal-srbija', sourceUrl: 'https://portal-srbija.com/a' };
const GRADJ: Provenance = {
  sourceId: 'gradjevinarstvo-rs',
  sourceUrl: 'https://gradjevinarstvo.rs/1',
};

function add(name: string, overrides: Partial<LeadInput> = {}, provenance = PORTAL): number {
  return upsertLead(
    db,
    { name, nameNormalized: foldForComparison(name), ...overrides },
    provenance,
    {
      matching: 'caller',
    },
  ).leadId;
}

beforeEach(() => {
  db = openTestDatabase();
  for (const [id, name] of [
    ['portal-srbija', 'Portal Srbija'],
    ['gradjevinarstvo-rs', 'Gradjevinarstvo.rs'],
  ] as const) {
    upsertSource(db, { id, name, url: `https://${id}.rs`, category: 'test' });
  }
});

afterEach(() => closeDatabase(db));

describe('headline numbers', () => {
  it('counts phone coverage on parseable numbers only', () => {
    add('Ima Broj', { phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }] });
    add('Nema Broj');
    add('Ima Smeće', {
      phones: [{ e164: '0xx xxx xxx, PRODAJA', raw: '0xx xxx xxx, PRODAJA', valid: false }],
    });

    const stats = dashboardStats(db);
    expect(stats.totalLeads).toBe(3);
    expect(stats.withPhone).toBe(1);
    expect(stats.withoutPhone).toBe(2);
    expect(stats.distinctPhones).toBe(1);
  });

  it('counts a number claimed by two sources once', () => {
    const id = add('Knauf', {
      phones: [{ e164: '+381112074500', raw: '011 2074 500', type: 'landline' }],
    });
    upsertLead(
      db,
      {
        leadId: id,
        name: 'Knauf',
        nameNormalized: 'knauf',
        phones: [{ e164: '+381112074500', raw: '+381 11 207 45 00', type: 'landline' }],
      },
      GRADJ,
      { matching: 'caller' },
    );
    expect(dashboardStats(db).distinctPhones).toBe(1);
  });

  it('breaks leads down by the labels actually stored, with phone coverage per label', () => {
    add('A', {
      classification: 'FACADE_CONTRACTOR',
      phones: [{ e164: '+381641111111', raw: '064 111 1111', type: 'mobile' }],
    });
    add('B', { classification: 'FACADE_CONTRACTOR' });
    add('C', { classification: 'UNKNOWN' });

    const byClass = dashboardStats(db).byClassification;
    const contractors = byClass.find((row) => row.classification === 'FACADE_CONTRACTOR');
    expect(contractors?.leads).toBe(2);
    expect(contractors?.withPhone).toBe(1);
    expect(byClass.map((row) => row.classification)).not.toContain('BOTH');
  });
});

describe('municipality coverage', () => {
  it('lists every one of Serbia’s local self-government units, crawled or not', () => {
    add('Jedina Firma', { municipalityId: 'cacak' });
    const coverage = municipalityCoverage(db);
    const expected = municipalities.filter((m) => m.parent_id == null).length;

    expect(coverage).toHaveLength(expected);
    expect(coverage[0]?.id).toBe('cacak');
    expect(coverage.filter((row) => row.leads === 0).length).toBe(expected - 1);
  });

  it('rolls a Belgrade city municipality up into beograd', () => {
    add('Firma u Vračaru', { cityId: 'beograd-vracar', municipalityId: 'beograd' });
    const coverage = municipalityCoverage(db);
    expect(coverage.find((row) => row.id === 'beograd')?.leads).toBe(1);
    expect(coverage.some((row) => row.id === 'beograd-vracar')).toBe(false);
  });

  it('counts contractors and stores per municipality, with BOTH in each', () => {
    add('X', { municipalityId: 'nis', classification: 'BOTH' });
    add('Y', { municipalityId: 'nis', classification: 'FACADE_CONTRACTOR' });
    const nis = municipalityCoverage(db).find((row) => row.id === 'nis');
    expect(nis?.contractors).toBe(2);
    expect(nis?.stores).toBe(1);
  });

  it('reports leads whose place string never matched a slug', () => {
    add('Nepoznato Mesto', { cityRaw: 'negde u Srbiji' });
    expect(dashboardStats(db).unmappedGeo).toBe(1);
  });
});

describe('source yield', () => {
  it('separates leads a source is the only witness for', () => {
    const shared = add('Deljena Firma');
    upsertLead(
      db,
      { leadId: shared, name: 'Deljena Firma', nameNormalized: 'deljena firma' },
      GRADJ,
      { matching: 'caller' },
    );
    add('Samo Portal');
    add('Samo Gradjevinarstvo', {}, GRADJ);

    const rows = sourceYield(db);
    const portal = rows.find((row) => row.sourceId === 'portal-srbija');
    expect(portal?.leads).toBe(2);
    expect(portal?.exclusive).toBe(1);
    const gradj = rows.find((row) => row.sourceId === 'gradjevinarstvo-rs');
    expect(gradj?.leads).toBe(2);
    expect(gradj?.exclusive).toBe(1);
  });
});

describe('growth', () => {
  it('accumulates leads across completed runs, in order, ignoring runs still going', () => {
    const first = startRun(db, 'portal-srbija', { startedAt: new Date('2026-08-21T08:00:00Z') });
    finishRun(db, first, 'completed', { leadsCreated: 10, leadsUpdated: 1, phonesAdded: 20 });
    const second = startRun(db, 'gradjevinarstvo-rs', {
      startedAt: new Date('2026-08-21T09:00:00Z'),
    });
    finishRun(db, second, 'completed', { leadsCreated: 5, leadsUpdated: 2, phonesAdded: 8 });
    startRun(db, 'portal-srbija', { startedAt: new Date('2026-08-21T10:00:00Z') });

    const points = growth(db);
    expect(points.map((point) => point.cumulativeLeads)).toEqual([10, 15]);
    expect(points.map((point) => point.sourceId)).toEqual(['portal-srbija', 'gradjevinarstvo-rs']);
  });
});

describe('review queue counters', () => {
  it('counts what is waiting for a human', () => {
    const a = add('A');
    const b = add('B');
    upsertMergeCandidate(db, {
      leadAId: a,
      leadBId: b,
      score: 0.6,
      topSignal: 'name_city',
      signalValue: 'a',
      signals: '[]',
    });
    expect(dashboardStats(db).reviewQueue.pendingMerges).toBe(1);
    expect(dashboardStats(db).reviewQueue.pendingSuggestions).toBe(0);
  });
});

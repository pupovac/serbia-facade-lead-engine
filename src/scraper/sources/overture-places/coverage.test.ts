/**
 * Coverage is the deliverable of this adapter as much as the leads are, so the
 * accounting is tested the same way the parsing is: over the saved extract
 * slice, with no network and no database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getMunicipalityById } from '@/lib/geo';
import {
  assign,
  coverageUnits,
  planScopes,
  scopeKey,
  summarize,
  UNASSIGNED,
  yieldOf,
} from './coverage.js';
import { placeRowSchema, type PlaceRow } from './place.js';

const rows: readonly PlaceRow[] = readFileSync(
  fileURLToPath(new URL('./__fixtures__/extract-sample.ndjson', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => placeRowSchema.parse(JSON.parse(line)));

const byName = (name: string): PlaceRow => {
  const row = rows.find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`fixture row missing: ${name}`);
  return row;
};

describe('assign', () => {
  it('resolves a Cyrillic locality to its municipality slug', () => {
    expect(assign(byName('Merkur Impex')).municipalityId).toBe('novi-sad');
  });

  it('resolves a Latin locality the same way', () => {
    expect(assign(byName('Farbara BeoWallz')).municipalityId).toBe('beograd');
  });

  it('rolls a Belgrade city municipality up to Belgrade and keeps the finer id', () => {
    const match = assign(byName('Kondominijum Hram Novi Surcin'));
    expect(match.municipalityId).toBe('beograd');
    expect(match.cityId).toBe('beograd-surcin');
  });

  it('falls back to the postcode when the locality is spelled in English', () => {
    // Overture writes `Belgrade` on a handful of records and the geo dataset
    // knows Serbian spellings only, so the postcode is what places this one.
    // That is why the postcode is prepended to the string the resolver sees.
    expect(byName('United City Group').locality).toBe('Belgrade');
    expect(assign(byName('United City Group')).municipalityId).toBe('beograd');
  });

  it('files a row with nothing to resolve as unassigned rather than guessing', () => {
    // No locality, an empty postcode, and a mobile number that says nothing
    // about a city. A wrong municipality is worse than none — the lead keeps
    // its phone number either way.
    expect(assign(byName('STRABAG site office Ostružnica project')).municipalityId).toBe(
      UNASSIGNED,
    );
  });

  it('tags each row with the arm of the query that found it', () => {
    expect(assign(byName('Merkur Impex')).arm).toBe('store-category');
    expect(assign(byName('Miltop Invest')).arm).toBe('contractor-category');
    expect(assign(byName('Stovariste Gradjevinskog Materijala Atlas')).arm).toBe('name-match');
  });
});

describe('planScopes', () => {
  const plan = planScopes(rows);

  it('walks every local self-government unit, empty ones included', () => {
    expect(coverageUnits).toHaveLength(145);
    // 145 units plus the unassigned bucket, times the three query arms.
    expect(plan).toHaveLength((145 + 1) * 3);
    expect(plan.filter((entry) => entry.rows.length === 0).length).toBeGreaterThan(0);
  });

  it('files every row into exactly one scope', () => {
    expect(plan.reduce((sum, entry) => sum + entry.rows.length, 0)).toBe(rows.length);
  });

  it('keys a scope by municipality and arm', () => {
    const novisad = plan.find((entry) => entry.scopeKey === scopeKey('novi-sad', 'store-category'));
    expect(novisad?.rows.map((entry) => entry.row.name)).toContain('Merkur Impex');
  });

  it('walks the biggest municipalities first', () => {
    const first = plan[0];
    expect(first?.municipalityId).toBe('beograd');
    expect(getMunicipalityById('beograd')?.priority_tier).toBe(1);
  });

  it('restricts the walk to the requested municipalities', () => {
    const novisad = getMunicipalityById('novi-sad');
    if (novisad === undefined) throw new Error('novi-sad missing from the geo dataset');
    const restricted = planScopes(rows, [novisad]);
    expect(
      restricted.every((entry) => ['novi-sad', UNASSIGNED].includes(entry.municipalityId)),
    ).toBe(true);
    const names = restricted.flatMap((entry) => entry.rows.map((row) => row.row.name));
    expect(names).toContain('Merkur Impex');
    expect(names).not.toContain('Farbara BeoWallz');
  });

  it('resolves a Belgrade city municipality when only that municipality was asked for', () => {
    const surcin = getMunicipalityById('beograd-surcin');
    if (surcin === undefined) throw new Error('beograd-surcin missing from the geo dataset');
    const names = planScopes(rows, [surcin]).flatMap((entry) =>
      entry.rows.map((row) => row.row.name),
    );
    expect(names).toContain('Kondominijum Hram Novi Surcin');
    expect(names).not.toContain('Farbara BeoWallz');
  });
});

describe('yieldOf', () => {
  it('counts what a scope produced, including the enrichment worklist', () => {
    const plan = planScopes(rows);
    const beograd = plan.find((entry) => entry.scopeKey === scopeKey('beograd', 'store-category'));
    if (beograd === undefined) throw new Error('beograd store scope missing');
    const stats = yieldOf(beograd, beograd.rows.length);
    expect(stats.records).toBe(beograd.rows.length);
    expect(stats.withPhone + stats.enrichmentTargets).toBeLessThanOrEqual(stats.records);
    expect(stats.offset).toBe(beograd.rows.length);
  });

  it('keeps the Belgrade city municipalities visible under the one unit', () => {
    const plan = planScopes(rows);
    const beograd = plan.find(
      (entry) => entry.scopeKey === scopeKey('beograd', 'contractor-category'),
    );
    if (beograd === undefined) throw new Error('beograd contractor scope missing');
    expect(Object.keys(yieldOf(beograd, 0).byCity)).toContain('beograd-surcin');
  });
});

describe('summarize', () => {
  it('reports coverage against the whole country, not against what was found', () => {
    const summary = summarize(planScopes(rows));
    expect(summary.records).toBe(rows.length);
    expect(summary.unitsTotal).toBe(145);
    expect(summary.unitsCovered).toBeLessThan(summary.unitsTotal);
    expect(summary.unassigned).toBe(
      rows.filter((row) => assign(row).municipalityId === UNASSIGNED).length,
    );
  });
});

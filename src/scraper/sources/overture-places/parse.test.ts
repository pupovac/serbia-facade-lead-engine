/**
 * The fixture test — a saved slice of a real extract in, an expected record set
 * out, no DuckDB, no S3, no database.
 *
 * `__fixtures__/extract-sample.ndjson` is 16 rows taken verbatim from the
 * 2026-08-19.0 national extract, chosen for the cases that are easy to get
 * wrong: a website with no phone, a record the category filter would have
 * missed, a locality spelled in Cyrillic, a locality spelled in English, and a
 * row with no locality at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { placeRowSchema, enrichmentMark, toRawLead, type PlaceRow } from './place.js';
import { rawLeadSchema } from '../../raw-lead.js';
import { placeUrl } from './dataset.js';

const RELEASE = '2026-08-19.0';

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

const lead = (row: PlaceRow) =>
  toRawLead(row, {
    release: RELEASE,
    scopeKey: 'mun:test|arm:store-category',
    municipalityId: 'test',
    cityId: 'test',
  });

describe('the extract fixture', () => {
  it('parses every saved row', () => {
    expect(rows).toHaveLength(16);
  });

  it('produces records the adapter boundary accepts', () => {
    for (const row of rows) {
      const result = rawLeadSchema.safeParse({ ...lead(row), sourceId: 'overture-places' });
      expect(result.success, `${row.name}: ${result.error?.message ?? ''}`).toBe(true);
    }
  });
});

describe('toRawLead', () => {
  it('carries the phone exactly as Overture published it', () => {
    const record = lead(byName('Merkur Impex'));
    // Raw, not canonical: `src/lib/phone` owns what a phone number is, and a
    // test that asserted a normalized form would be testing that module.
    expect(record.phones).toEqual(byName('Merkur Impex').phones);
    expect(record.city).toBe('Нови Сад');
  });

  it('points every record at a browsable map view of its GERS id', () => {
    const row = byName('Merkur Impex');
    const record = lead(row);
    expect(record.sourceUrl).toBe(
      placeUrl(
        row.id,
        row.latitude === null || row.longitude === null
          ? undefined
          : { latitude: row.latitude, longitude: row.longitude },
      ),
    );
    expect(new URL(record.sourceUrl).searchParams.get('feature')).toBe(`places.place.${row.id}`);
    // The release is provenance and stays on the record — but not in the URL,
    // so a monthly release does not invalidate every stored `source_url`.
    expect(record.sourceUrl).not.toContain(RELEASE);
    expect(record.extra?.release).toBe(RELEASE);
    expect(record.extra?.gersId).toBe(row.id);
  });

  it('keeps the record block as evidence for the shared extractors', () => {
    const record = lead(byName('Lordex / Tadex Zaječar'));
    expect(record.text).toContain('Lordex / Tadex Zaječar');
    expect(record.links?.some((link) => link.href.startsWith('mailto:'))).toBe(true);
    expect(record.links?.some((link) => link.text === 'social')).toBe(true);
  });

  it('records which arm of the query found the row, not what the lead is', () => {
    expect(lead(byName('Merkur Impex')).extra?.queryArm).toBe('store-category');
    expect(lead(byName('Miltop Invest')).extra?.queryArm).toBe('contractor-category');
    // Filed under `home_goods_store` — the category filter alone loses it.
    expect(lead(byName('Stovariste Gradjevinskog Materijala Atlas')).extra?.queryArm).toBe(
      'name-match',
    );
  });

  it('emits a low-confidence record rather than discarding a phone number', () => {
    const low = rows.filter((row) => (row.confidence ?? 1) < 0.3 && (row.phones ?? []).length > 0);
    expect(low.length).toBeGreaterThan(0);
    for (const row of low) {
      expect(lead(row).phones?.length).toBeGreaterThan(0);
      expect(lead(row).extra?.confidence).toBe(row.confidence);
    }
  });

  it('emits an empty phone list rather than dropping a website-only record', () => {
    const record = lead(byName('Vermax alati'));
    expect(record.phones).toEqual([]);
    expect(record.website).toBe((byName('Vermax alati').websites ?? [])[0]);
  });
});

describe('enrichmentMark', () => {
  it('marks a website with no phone for the enrichment crawler', () => {
    const row = byName('Vermax alati');
    expect(enrichmentMark(row)).toEqual({
      needed: true,
      reason: 'website_without_phone',
      website: (row.websites ?? [])[0],
    });
    expect(lead(byName('Vermax alati')).extra?.enrichment).toBeDefined();
  });

  it('leaves a record that already has a phone alone', () => {
    expect(enrichmentMark(byName('Merkur Impex'))).toBeNull();
    expect(lead(byName('Merkur Impex')).extra?.enrichment).toBeUndefined();
  });

  it('leaves a record with neither a phone nor a website alone', () => {
    expect(enrichmentMark(byName('STRABAG site office Ostružnica project'))).toBeNull();
  });

  it('turns the empty strings Overture writes for an absent field into nothing', () => {
    // `postcode: ""` on this row. `min(1)` at the boundary rejects an empty
    // string, and a record must not be lost to a field it never had.
    const record = lead(byName('STRABAG site office Ostružnica project'));
    expect(record.postalCode).toBeNull();
    expect(record.city).toBeNull();
  });
});

describe('placeRowSchema', () => {
  it('rejects a row that lost the field the parser reads', () => {
    const { name: _name, ...withoutName } = byName('Merkur Impex');
    expect(placeRowSchema.safeParse(withoutName).success).toBe(false);
  });

  it('accepts the SQL NULLs DuckDB writes for an empty list', () => {
    const parsed = placeRowSchema.parse({
      id: 'gers-1',
      name: 'Fasade Test',
      category: null,
      phones: null,
      websites: null,
    });
    expect(parsed.phones).toBeNull();
    expect(
      toRawLead(parsed, {
        release: RELEASE,
        scopeKey: 'mun:test|arm:name-match',
        municipalityId: null,
        cityId: null,
      }).phones,
    ).toEqual([]);
  });
});

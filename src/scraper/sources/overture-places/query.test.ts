/**
 * The query, the release pin and the listing parser — the three things that
 * decide what gets read at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isTruncated,
  listUrl,
  parseKeys,
  partUrl,
  placeUrl,
  placesPrefix,
  RELEASE,
} from './dataset.js';
import {
  armFor,
  describeSql,
  extractSql,
  nameRegExp,
  NAME_PATTERN,
  REQUIRED_COLUMNS,
  TARGET_CATEGORIES,
} from './query.js';
import { missingColumns, queryHash } from './warehouse.js';

const listing = readFileSync(
  fileURLToPath(new URL('./__fixtures__/list-objects.xml', import.meta.url)),
  'utf8',
);

const parts = parseKeys(listing).map(partUrl);

describe('the release listing', () => {
  it('reads every parquet part out of a real ListObjectsV2 response', () => {
    const keys = parseKeys(listing);
    expect(keys).toHaveLength(16);
    expect(keys.every((key) => key.startsWith(placesPrefix()))).toBe(true);
    expect(keys.every((key) => key.endsWith('.parquet'))).toBe(true);
  });

  it('reports a complete listing as complete', () => {
    expect(isTruncated(listing)).toBe(false);
    expect(isTruncated('<IsTruncated>true</IsTruncated>')).toBe(true);
  });

  it('finds nothing in a listing for a release that does not exist', () => {
    // S3 answers a missing prefix with a valid, empty listing — a 200, not a
    // 404 — so an empty key list is the only signal that the pin is wrong.
    expect(parseKeys('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>')).toEqual([]);
  });

  it('asks for the pinned release and nothing else', () => {
    expect(new URL(listUrl()).searchParams.get('prefix')).toBe(placesPrefix(RELEASE));
    expect(new URL(listUrl('2020-01-01.0')).searchParams.get('prefix')).toBe(
      placesPrefix('2020-01-01.0'),
    );
  });

  it('points a record at its release and its GERS id', () => {
    expect(placeUrl('abc-123', '2026-08-19.0')).toBe(
      'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-08-19.0/theme=places/type=place/#abc-123',
    );
  });
});

describe('extractSql', () => {
  const sql = extractSql(parts);

  it('reads every part of the pinned release', () => {
    for (const part of parts) expect(sql).toContain(part);
  });

  it('filters to Serbia by country, not only by bounding box', () => {
    expect(sql).toContain("addresses[1].country = 'RS'");
    expect(sql).toContain('bbox.xmin BETWEEN 18.8 AND 23.1');
  });

  it('keeps both arms of the search', () => {
    for (const category of TARGET_CATEGORIES) expect(sql).toContain(`'${category}'`);
    expect(sql).toContain(NAME_PATTERN);
  });

  it('does not filter on confidence', () => {
    // Measured on this release, `confidence >= 0.3` drops 379 phone-bearing
    // records — 23% of the phone yield. See `query.ts` for the reasoning; this
    // test is here so a future "tidy-up" has to argue with the number.
    expect(sql).not.toContain('confidence >=');
    expect(sql).toContain('confidence,');
  });

  it('reads the taxonomy field the current releases use', () => {
    expect(sql).toContain('taxonomy.primary');
    expect(sql).not.toContain('categories.primary');
  });

  it('escapes a quote rather than closing the string', () => {
    expect(extractSql(["https://example.com/o'brien.parquet"])).toContain("o''brien.parquet");
  });

  it('probes the schema with a statement that reads one row', () => {
    expect(describeSql(parts)).toContain('DESCRIBE');
    expect(describeSql(parts)).toContain('LIMIT 1');
  });
});

describe('the name pattern', () => {
  it.each([
    ['Stovariste Bihorac', true],
    ['Stovarište Megakomerc', true],
    ['Euro Okov građevinski materijal', true],
    ['Gradjevinski Centar Krusevac', true],
    ['DMR Hidroizolacija Niš', true],
    ['Termo fasade Novi Sad', true],
    ['Moleraj-krecenje', true],
    ['Mašinsko Malterisanje GMS', true],
    ['Pekara Sunce', false],
    ['Auto servis Petrović', false],
  ])('%s → %s', (name, expected) => {
    expect(nameRegExp.test(name.toLowerCase())).toBe(expected);
  });
});

describe('armFor', () => {
  it('separates the contractor categories from the store categories', () => {
    expect(armFor('building_or_construction_service')).toBe('contractor-category');
    expect(armFor('hardware_store')).toBe('store-category');
  });

  it('calls anything outside the target categories a name match', () => {
    expect(armFor('home_goods_store')).toBe('name-match');
    expect(armFor(null)).toBe('name-match');
  });
});

describe('the schema guard', () => {
  it('accepts a release that still has every column the extract reads', () => {
    expect(missingColumns([...REQUIRED_COLUMNS, 'geometry'])).toEqual([]);
  });

  it('names the column a release dropped', () => {
    // Overture moved `categories.primary` to `taxonomy.primary` once already.
    const present = REQUIRED_COLUMNS.filter((column) => column !== 'taxonomy');
    expect(missingColumns(present)).toEqual(['taxonomy']);
  });
});

describe('queryHash', () => {
  it('changes when the query changes, so an old cache cannot answer a new question', () => {
    expect(queryHash(extractSql(parts))).toBe(queryHash(extractSql(parts)));
    expect(queryHash(extractSql(parts))).not.toBe(queryHash(extractSql(parts.slice(0, 1))));
  });
});

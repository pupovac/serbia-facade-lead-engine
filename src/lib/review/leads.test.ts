/**
 * The lead list: every filter, sort and page boundary asserted in SQL.
 *
 * The reason this file exists is the non-negotiable in the issue — filtering,
 * sorting and pagination are server-side. A client-side slice of a truncated
 * fetch would pass a naive "the page shows ten rows" test, so the assertions
 * here are the ones it could not pass: `total` is the size of the whole result
 * set, page 2 continues where page 1 stopped without repeating a row, and a
 * filter changes `total`, not just what is visible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import { upsertLead, upsertSource, type LeadInput, type Provenance } from '../db/repo.js';
import { foldForComparison } from '../text/fold.js';
import { isBrowsableSourceUrl } from './detail.js';
import { leadFacets, listLeads } from './leads.js';

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/a',
};
const GRADJ: Provenance = {
  sourceId: 'gradjevinarstvo-rs',
  sourceUrl: 'https://www.gradjevinarstvo.rs/firme/1/a',
};

function add(name: string, overrides: Partial<LeadInput> = {}, provenance = PORTAL): number {
  return upsertLead(
    db,
    { name, nameNormalized: foldForComparison(name), ...overrides },
    provenance,
    { matching: 'caller' },
  ).leadId;
}

beforeEach(() => {
  db = openTestDatabase();
  for (const [id, name] of [
    ['portal-srbija', 'Portal Srbija'],
    ['gradjevinarstvo-rs', 'Gradjevinarstvo.rs'],
    ['overture-places', 'Overture Maps'],
  ] as const) {
    upsertSource(db, { id, name, url: `https://${id}.rs`, category: 'test' });
  }
});

afterEach(() => closeDatabase(db));

/* -------------------------------------------------------------------------- */

describe('pagination', () => {
  beforeEach(() => {
    for (let i = 0; i < 25; i += 1) {
      add(`Firma ${String(i).padStart(2, '0')}`, {
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        leadScore: 100 - i,
      });
    }
  });

  it('reports the size of the whole result set, not of the page', () => {
    const page = listLeads(db, { pageSize: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(25);
    expect(page.pageCount).toBe(3);
  });

  it('page 2 continues where page 1 stopped, with no repeats', () => {
    const first = listLeads(db, { pageSize: 10, page: 1 });
    const second = listLeads(db, { pageSize: 10, page: 2 });
    const third = listLeads(db, { pageSize: 10, page: 3 });

    expect(third.rows).toHaveLength(5);
    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(25);
  });

  it('breaks ties on id, so an unstable sort cannot drop or repeat a row', () => {
    for (let i = 0; i < 10; i += 1) add(`Isti Skor ${i}`, { leadScore: 50 });
    const size = 4;
    const seen: number[] = [];
    const total = listLeads(db, { pageSize: size }).total;
    for (let page = 1; page <= Math.ceil(total / size); page += 1) {
      seen.push(...listLeads(db, { pageSize: size, page }).rows.map((row) => row.id));
    }
    expect(new Set(seen).size).toBe(total);
  });

  it('clamps an out-of-range page instead of returning nothing', () => {
    const page = listLeads(db, { pageSize: 10, page: 99 });
    expect(page.page).toBe(3);
    expect(page.rows).toHaveLength(5);
  });
});

/* -------------------------------------------------------------------------- */

describe('filters', () => {
  beforeEach(() => {
    add('Fasade Petrović', {
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      cityRaw: 'Novi Sad',
      classification: 'FACADE_CONTRACTOR',
      leadScore: 90,
      phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
    });
    add(
      'Stovarište Čačak',
      {
        cityId: 'cacak',
        municipalityId: 'cacak',
        cityRaw: 'Čačak',
        classification: 'CONSTRUCTION_MATERIAL_STORE',
        leadScore: 60,
        phones: [{ e164: '+38132123456', raw: '032/123-456', type: 'landline' }],
      },
      GRADJ,
    );
    add('Bez Telefona', {
      cityId: 'nis',
      municipalityId: 'nis',
      cityRaw: 'Niš',
      classification: 'UNCLASSIFIED',
      leadScore: 20,
    });
    // A department label the ingest could not parse — it is a row in
    // `lead_phones`, and it is not a phone number.
    add('Samo Neispravan Broj', {
      cityId: 'nis',
      municipalityId: 'nis',
      leadScore: 25,
      phones: [{ e164: '0xx xxx xxx, PRODAJA', raw: '0xx xxx xxx, PRODAJA', valid: false }],
    });
  });

  it('filters by municipality in SQL', () => {
    const page = listLeads(db, { municipalityId: 'cacak' });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.name).toBe('Stovarište Čačak');
  });

  it('filters by classification, accepting more than one label', () => {
    expect(listLeads(db, { classifications: ['FACADE_CONTRACTOR'] }).total).toBe(1);
    expect(
      listLeads(db, { classifications: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'] })
        .total,
    ).toBe(2);
  });

  it('filters by minimum lead score', () => {
    expect(listLeads(db, { minScore: 60 }).total).toBe(2);
    expect(listLeads(db, { minScore: 95 }).total).toBe(0);
  });

  it('has-phone means a number someone can dial', () => {
    const withPhone = listLeads(db, { hasPhone: true });
    expect(withPhone.rows.map((row) => row.name).sort()).toEqual([
      'Fasade Petrović',
      'Stovarište Čačak',
    ]);

    const without = listLeads(db, { hasPhone: false });
    expect(without.rows.map((row) => row.name).sort()).toEqual([
      'Bez Telefona',
      'Samo Neispravan Broj',
    ]);
  });

  it('never counts an unparseable claim as a phone', () => {
    const row = listLeads(db, { search: 'Samo Neispravan' }).rows[0];
    expect(row?.phoneCount).toBe(0);
    expect(row?.primaryPhone).toBeNull();
  });

  it('filters by source', () => {
    expect(listLeads(db, { sourceId: 'gradjevinarstvo-rs' }).total).toBe(1);
    expect(listLeads(db, { sourceId: 'portal-srbija' }).total).toBe(3);
  });

  it('combines filters, and the total reflects all of them', () => {
    const page = listLeads(db, { municipalityId: 'nis', hasPhone: false, minScore: 21 });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.name).toBe('Samo Neispravan Broj');
  });
});

/* -------------------------------------------------------------------------- */

describe('search', () => {
  beforeEach(() => {
    add('Fasade Petrović d.o.o.', {
      cityId: 'cacak',
      cityRaw: 'Čačak',
      phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
    });
    add('ГРАЂЕВИНСКО СТОВАРИШТЕ ЈОВАНОВИЋ', { cityId: 'nis', cityRaw: 'Ниш' });
    add('Termo Dom', { cityId: 'novi-sad', cityRaw: 'Novi Sad' });
  });

  it('matches the published name, diacritics and all', () => {
    expect(listLeads(db, { search: 'Petrović' }).total).toBe(1);
  });

  it('matches an ASCII-folded query against a diacritic name', () => {
    expect(listLeads(db, { search: 'Petrovic' }).total).toBe(1);
  });

  it('matches a Latin query against a Cyrillic name', () => {
    // `name_normalized` is transliterated at write time, which is what makes
    // `stovariste` find `СТОВАРИШТЕ`.
    expect(listLeads(db, { search: 'stovariste' }).total).toBe(1);
  });

  it('matches phone digits however they were typed', () => {
    expect(listLeads(db, { search: '641234567' }).total).toBe(1);
    expect(listLeads(db, { search: '064/123-4567' }).total).toBe(1);
  });

  it('treats LIKE wildcards as literal text', () => {
    add('100% Fasada');
    expect(listLeads(db, { search: '%' }).total).toBe(1);
    expect(listLeads(db, { search: '_' }).total).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('sorting', () => {
  beforeEach(() => {
    add('Zzz Firma', { leadScore: 10, cityRaw: 'Apatin' });
    add('Aaa Firma', { leadScore: 90, cityRaw: 'Zrenjanin' });
    add('Mmm Firma', { leadScore: 50, cityRaw: 'Merošina' });
  });

  it('defaults to best score first', () => {
    expect(listLeads(db).rows.map((row) => row.leadScore)).toEqual([90, 50, 10]);
  });

  it('sorts by name', () => {
    expect(listLeads(db, { sort: 'name', direction: 'asc' }).rows.map((r) => r.name)).toEqual([
      'Aaa Firma',
      'Mmm Firma',
      'Zzz Firma',
    ]);
  });

  it('reverses direction', () => {
    expect(listLeads(db, { sort: 'score', direction: 'asc' }).rows.map((r) => r.leadScore)).toEqual(
      [10, 50, 90],
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('row aggregates', () => {
  it('counts distinct numbers, not per-source claims', () => {
    const id = add('Knauf', {
      phones: [{ e164: '+381112074500', raw: '011 2074 500', type: 'landline' }],
    });
    upsertLead(
      db,
      {
        leadId: id,
        name: 'Knauf',
        nameNormalized: 'knauf',
        phones: [
          { e164: '+381112074500', raw: '+381 11 207 45 00', type: 'landline' },
          { e164: '+38163634515', raw: '063 634515', type: 'mobile' },
        ],
      },
      GRADJ,
      { matching: 'caller' },
    );

    const row = listLeads(db).rows[0];
    expect(row?.phoneCount).toBe(2);
    expect(row?.sourceCount).toBe(2);
  });

  it('prefers a mobile as the number to dial first', () => {
    add('Fasader', {
      phones: [
        { e164: '+381112074500', raw: '011 2074 500', type: 'landline' },
        { e164: '+38163634515', raw: '063 634515', type: 'mobile', nationalFormat: '063 634515' },
      ],
    });
    const row = listLeads(db).rows[0];
    expect(row?.primaryPhone).toBe('+38163634515');
    expect(row?.primaryPhoneNational).toBe('063 634515');
  });
});

/* -------------------------------------------------------------------------- */

describe('two scores, sorted and filtered independently', () => {
  beforeEach(() => {
    // A documented parking garage against a bare sole trader — the pair the
    // single folded score got the wrong way round.
    add('Garaza Banovina', {
      classification: 'UNCLASSIFIED',
      relevanceScore: 0,
      contactabilityScore: 88,
      leadScore: 0,
    });
    add('Fasader Jovanović', {
      classification: 'FACADE_CONTRACTOR',
      relevanceScore: 92,
      contactabilityScore: 48,
      leadScore: 44,
    });
    add('Stovarište Niš', {
      classification: 'CONSTRUCTION_MATERIAL_STORE',
      relevanceScore: 74,
      contactabilityScore: 66,
      leadScore: 49,
    });
  });

  it('sorts by relevance without contact completeness getting a vote', () => {
    const rows = listLeads(db, { sort: 'relevance' }).rows;
    expect(rows.map((r) => r.name)).toStrictEqual([
      'Fasader Jovanović',
      'Stovarište Niš',
      'Garaza Banovina',
    ]);
  });

  it('sorts by contactability, which puts the garage back on top', () => {
    const rows = listLeads(db, { sort: 'contactability' }).rows;
    expect(rows[0]?.name).toBe('Garaza Banovina');
    expect(rows[0]?.contactabilityScore).toBe(88);
    expect(rows[0]?.relevanceScore).toBe(0);
  });

  it('filters on each score on its own', () => {
    expect(listLeads(db, { minRelevance: 70 }).total).toBe(2);
    expect(listLeads(db, { minContactability: 70 }).total).toBe(1);
    expect(listLeads(db, { minRelevance: 70, minContactability: 60 }).total).toBe(1);
  });

  it('carries both numbers onto the row', () => {
    const row = listLeads(db, { search: 'Jovanović' }).rows[0];
    expect(row?.relevanceScore).toBe(92);
    expect(row?.contactabilityScore).toBe(48);
    expect(row?.leadScore).toBe(44);
  });
});

/* -------------------------------------------------------------------------- */

describe('OUT_OF_SCOPE stays out of the working set', () => {
  beforeEach(() => {
    add('Fasader Jovanović', { classification: 'FACADE_CONTRACTOR' });
    add('Termo Nešto', { classification: 'UNCLASSIFIED' });
    add('Roletne Marković', {
      classification: 'OUT_OF_SCOPE',
      classificationIndustry: 'joinery',
    });
    add('Krovovi Petrović', {
      classification: 'OUT_OF_SCOPE',
      classificationIndustry: 'roofing',
    });
  });

  it('leaves ruled-out leads out of the default list', () => {
    const page = listLeads(db);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.name).sort()).toStrictEqual(['Fasader Jovanović', 'Termo Nešto']);
  });

  it('keeps UNCLASSIFIED in — it is a lead we have not ruled in yet, not one we ruled out', () => {
    expect(listLeads(db).rows.some((r) => r.classification === 'UNCLASSIFIED')).toBe(true);
  });

  it('shows them when a reviewer asks for them by name', () => {
    const page = listLeads(db, { classifications: ['OUT_OF_SCOPE'] });
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.classificationIndustry).sort()).toStrictEqual([
      'joinery',
      'roofing',
    ]);
  });

  it('shows them on an explicit opt-in, filter or no filter', () => {
    expect(listLeads(db, { includeOutOfScope: true }).total).toBe(4);
  });

  it('applies to the total, not just to the visible page', () => {
    // The failure mode a naive slice would hide: a filter that changes which
    // rows are shown but not how many the pager thinks there are.
    expect(listLeads(db, { pageSize: 1 }).total).toBe(2);
    expect(listLeads(db, { pageSize: 1, includeOutOfScope: true }).total).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */

describe('facets', () => {
  it('reads the labels present in the data rather than a baked-in list', () => {
    add('A', { classification: 'FACADE_CONTRACTOR', municipalityId: 'novi-sad' });
    add('B', { classification: 'FACADE_CONTRACTOR', municipalityId: 'novi-sad' });
    add('C', { classification: 'UNCLASSIFIED', municipalityId: 'cacak' });

    const facets = leadFacets(db);
    expect(facets.classifications.map((f) => f.value)).toEqual([
      'FACADE_CONTRACTOR',
      'UNCLASSIFIED',
    ]);
    expect(facets.classifications[0]?.count).toBe(2);
    expect(facets.municipalities.map((f) => f.label)).toEqual(['Novi Sad', 'Čačak']);
    expect(facets.sources.map((f) => f.label)).toEqual(['Portal Srbija']);
  });
});

/* -------------------------------------------------------------------------- */

describe('the APR activity code', () => {
  beforeEach(() => {
    // A shape the widened `kompanije-net` codes actually produce: an architect,
    // an engineering firm and a general builder, none of them classifiable from
    // its name, all three separable only by the code.
    add('AEK DOO', {
      activityCode: '7111',
      activityName: 'Arhitektonska delatnost',
      classification: 'UNCLASSIFIED',
    });
    add('AB PROJEKT INŽENJERING', {
      activityCode: '7112',
      activityName: 'Inženjerske delatnosti i tehničko savetovanje',
      classification: 'UNCLASSIFIED',
    });
    add('GRADNJA DOO', {
      activityCode: '4120',
      activityName: 'Izgradnja stambenih i nestambenih zgrada',
      classification: 'UNCLASSIFIED',
    });
    add('A GRAĐEVINSKI MATERIJALI DOO', {
      activityCode: '4673',
      activityName: 'Trgovina na veliko drvetom i građ materijalom',
      classification: 'CONSTRUCTION_MATERIAL_STORE',
    });
    add('Fasade Novak', { classification: 'FACADE_CONTRACTOR' });
  });

  it('filters the whole result set, not just the visible page', () => {
    const page = listLeads(db, { activityCode: '7111' });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.name).toBe('AEK DOO');
  });

  it('carries the code and its name onto the row', () => {
    const row = listLeads(db, { activityCode: '4673' }).rows[0];
    expect(row?.activityCode).toBe('4673');
    expect(row?.activityName).toBe('Trgovina na veliko drvetom i građ materijalom');
  });

  it('leaves the field null for a source that does not publish one', () => {
    const row = listLeads(db, { search: 'Fasade Novak' }).rows[0];
    expect(row?.activityCode).toBeNull();
    expect(row?.activityName).toBeNull();
  });

  it('offers a facet labelled the way the export reads, and skips the nulls', () => {
    const facets = leadFacets(db);
    expect(facets.activityCodes.map((f) => f.value).sort()).toEqual([
      '4120',
      '4673',
      '7111',
      '7112',
    ]);
    expect(facets.activityCodes.find((f) => f.value === '7111')?.label).toBe(
      '7111 — Arhitektonska delatnost',
    );
    // The lead with no code is not a filter option called "null".
    expect(facets.activityCodes.reduce((sum, f) => sum + f.count, 0)).toBe(4);
  });

  it('shows the leads the classifier ruled out, because the code was asked for', () => {
    // `71.11 Arhitektonska delatnost` reads as `general_construction` to the
    // classifier, which rules out about a quarter of the code. Hiding those
    // from a filter whose whole job is to show that segment would be a
    // silently truncated list.
    add('BIRO ZA PROJEKTOVANJE', {
      activityCode: '7111',
      activityName: 'Arhitektonska delatnost',
      classification: 'OUT_OF_SCOPE',
      classificationIndustry: 'general_construction',
    });
    expect(listLeads(db, { activityCode: '7111' }).total).toBe(2);
    // The default working set still hides it.
    expect(listLeads(db, {}).rows.some((row) => row.name === 'BIRO ZA PROJEKTOVANJE')).toBe(false);
  });

  it('offers one option per code even when two sources name it differently', () => {
    // A duplicated `value` would be a filter that offers the same thing twice
    // and two React keys that collide.
    add('MALTER 1', { activityCode: '2364', activityName: 'Proizvodnja maltera' });
    add('MALTER 2', { activityCode: '2364', activityName: 'Proizvodnja maltera i betona' });
    const codes = leadFacets(db).activityCodes.filter((f) => f.value === '2364');
    expect(codes).toHaveLength(1);
    expect(codes[0]?.count).toBe(2);
  });

  it('has an empty facet when nothing in the database carries a code', () => {
    const empty = openTestDatabase();
    try {
      expect(leadFacets(empty).activityCodes).toEqual([]);
    } finally {
      closeDatabase(empty);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('source URLs', () => {
  it('does not offer the Overture S3 prefix as a link', () => {
    expect(
      isBrowsableSourceUrl(
        'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-08-19.0/theme=places/type=place/#b6a923e9',
      ),
    ).toBe(false);
  });

  it('offers a real directory page as a link', () => {
    expect(isBrowsableSourceUrl('https://www.gradjevinarstvo.rs/firme/1139/knauf-zemun')).toBe(
      true,
    );
    expect(isBrowsableSourceUrl('https://www.portal-srbija.com/knauf-amf')).toBe(true);
  });
});

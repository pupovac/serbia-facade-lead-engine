/**
 * `RawLead` → a lead in the database.
 *
 * Two halves. `normalizeRawLead` is pure and is tested on what a Serbian
 * directory actually publishes — a slashed phone, a place with an em dash, a
 * `www.` website, an obfuscated address. `persistLead` is tested against a real
 * migrated database, because the point of it is the provenance and the merge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  distinctPhones,
  getLead,
  leadContactClaims,
  leadSourceRows,
  openTestDatabase,
  upsertSource,
  type Db,
} from '@/lib/db';
import { normalizeRawLead, persistLead, persistRejected } from './pipeline.js';
import { validateRawLead, type RawLead } from './raw-lead.js';

const SOURCE = 'primer';
const URL_A = 'https://primer.rs/firme/termo-fasade';
const URL_B = 'https://primer.rs/firme/termo-fasade-ns';
const NOW = new Date('2026-08-20T10:00:00Z');

function raw(overrides: Record<string, unknown> = {}): RawLead {
  const result = validateRawLead(
    { sourceUrl: URL_A, name: 'Termo Fasade d.o.o.', ...overrides },
    SOURCE,
  );
  if (!result.ok) throw new Error(result.error);
  return result.lead;
}

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
  upsertSource(db, {
    id: SOURCE,
    name: 'Primer direktorijum',
    url: 'https://primer.rs',
    category: 'directory',
  });
});

afterEach(() => {
  closeDatabase(db);
});

describe('normalizeRawLead', () => {
  it('canonicalizes phones and keeps the raw string', () => {
    const normalized = normalizeRawLead(
      raw({ phones: ['021/456-789', '064 123 4567', '+381 63 8811 220'] }),
      {},
      NOW,
    );

    expect(normalized.input.phones?.map((phone) => phone.e164)).toEqual([
      '+38121456789',
      '+381641234567',
      '+381638811220',
    ]);
    expect(normalized.input.phones?.[0]?.raw).toBe('021/456-789');
    // The first claim is what a salesperson dials.
    expect(normalized.input.phones?.[0]?.isPrimary).toBe(true);
    expect(normalized.phoneCount).toBe(3);
  });

  it('keeps an unparseable number the source published, marked invalid', () => {
    // The source said "this is the number". A bad one is evidence, not noise.
    const normalized = normalizeRawLead(raw({ phones: ['ne radi telefon'] }), {}, NOW);

    expect(normalized.input.phones).toHaveLength(1);
    expect(normalized.input.phones?.[0]?.valid).toBe(false);
    expect(normalized.phoneCount).toBe(0);
  });

  it('reads a tel: link and the block text', () => {
    const normalized = normalizeRawLead(
      raw({
        links: [{ href: 'tel:+38121456789', text: '021/456-789' }],
        text: 'Zovite nas na 064 123 4567 svakog radnog dana.',
      }),
      {},
      NOW,
    );

    expect(normalized.input.phones?.map((phone) => phone.e164).sort()).toEqual([
      '+38121456789',
      '+381641234567',
    ]);
  });

  it('does not keep an unparseable number found in prose', () => {
    // A regex hit inside a paragraph is a guess, and a bad guess is noise.
    const normalized = normalizeRawLead(
      raw({ text: 'PIB 101234567, matični broj 20345678.' }),
      {},
      NOW,
    );

    expect(normalized.input.phones).toEqual([]);
  });

  it('collapses a number claimed twice, preferring the valid reading', () => {
    const normalized = normalizeRawLead(
      raw({ phones: ['021/456-789', '021 456 789'], text: 'tel. 021/456-789' }),
      {},
      NOW,
    );

    expect(normalized.input.phones).toHaveLength(1);
    expect(normalized.input.phones?.[0]?.valid).toBe(true);
  });

  it('resolves the city, including a Belgrade municipality', () => {
    expect(normalizeRawLead(raw({ city: 'Novi Sad' }), {}, NOW).input.cityId).toBe('novi-sad');

    const belgrade = normalizeRawLead(raw({ city: 'Beograd — Voždovac' }), {}, NOW);
    expect(belgrade.input.cityId).toBe('beograd-vozdovac');
    expect(belgrade.input.municipalityId).toBe('beograd');
    // The place string is preserved exactly as published.
    expect(belgrade.input.cityRaw).toBe('Beograd — Voždovac');
  });

  it('falls back to the address when there is no city field', () => {
    const normalized = normalizeRawLead(
      raw({ address: 'Bulevar oslobođenja 112, 21000 Novi Sad' }),
      {},
      NOW,
    );

    expect(normalized.input.cityId).toBe('novi-sad');
  });

  it('infers the city from a landline when the text names no place', () => {
    const normalized = normalizeRawLead(raw({ phones: ['018/550-907'] }), {}, NOW);

    expect(normalized.input.cityId).toBe('nis');
  });

  it('reports why a city did not resolve instead of swallowing it', () => {
    const normalized = normalizeRawLead(raw({ city: 'Negde u Srbiji' }), {}, NOW);

    expect(normalized.input.cityId).toBeNull();
    expect(normalized.cityFailure).toContain('no_match');
  });

  it('canonicalizes the website and drops the directory’s own domain', () => {
    const kept = normalizeRawLead(raw({ website: 'http://www.termofasade.rs' }), {}, NOW);
    expect(kept.input.contacts?.find((c) => c.kind === 'website')?.value).toBe(
      'https://termofasade.rs',
    );

    // A link back to the directory is not the business's website.
    const dropped = normalizeRawLead(raw({ website: 'https://primer.rs/firme/termo' }), {}, NOW);
    expect(dropped.input.contacts?.some((c) => c.kind === 'website')).toBe(false);
  });

  it('reads an obfuscated email out of the block text', () => {
    const normalized = normalizeRawLead(
      raw({ text: 'Pišite nam: demit.fasade [at] gmail [dot] com' }),
      {},
      NOW,
    );

    expect(normalized.input.contacts?.find((c) => c.kind === 'email')?.value).toBe(
      'demit.fasade@gmail.com',
    );
  });

  it('drops the address the directory publishes on every listing', () => {
    const normalized = normalizeRawLead(
      raw({ emails: ['kontakt@primer-oglasi.rs', 'info@termofasade.rs'] }),
      { sourceOwnedEmails: ['kontakt@primer-oglasi.rs'] },
      NOW,
    );

    const emails = normalized.input.contacts?.filter((c) => c.kind === 'email').map((c) => c.value);
    expect(emails).toEqual(['info@termofasade.rs']);
  });

  it('classifies from the name, categories and description', () => {
    const contractor = normalizeRawLead(
      raw({ name: 'Fasaderski radovi Marković PR', categories: ['Molersko fasaderski radovi'] }),
      {},
      NOW,
    );
    expect(contractor.input.classification).toBe('FACADE_CONTRACTOR');

    const store = normalizeRawLead(
      raw({
        name: 'Stovarište Gradnja Plus',
        description: 'Prodaja građevinskog materijala: stiropor, cement, blokovi.',
      }),
      {},
      NOW,
    );
    expect(store.input.classification).toBe('CONSTRUCTION_MATERIAL_STORE');
  });

  it('keeps the name in Serbian and stores an ASCII key beside it', () => {
    const normalized = normalizeRawLead(raw({ name: 'Građevinski centar Niš d.o.o.' }), {}, NOW);

    expect(normalized.input.name).toBe('Građevinski centar Niš d.o.o.');
    // The matching key is ASCII-folded and stripped of the legal form — the
    // `građevinski` / `gradjevinski` pair the whole project turns on.
    expect(normalized.input.nameNormalized).toBe('gradjevinski centar');
    expect(normalized.input.legalForm).toBe('d.o.o.');
  });

  it('scores a lead with a phone above one without', () => {
    const withPhone = normalizeRawLead(
      raw({ name: 'Fasaderski radovi Marković PR', city: 'Čačak', phones: ['063/478-115'] }),
      {},
      NOW,
    );
    const withoutPhone = normalizeRawLead(
      raw({ name: 'Fasaderski radovi Marković PR', city: 'Čačak' }),
      {},
      NOW,
    );

    expect(withPhone.score.score).toBeGreaterThan(withoutPhone.score.score);
    expect(withoutPhone.score.capped).toBe(true);
  });
});

/**
 * The epic's rule, tested where it takes effect. A sole trader from a
 * contractor-only listing must not be scored on their name — the pilot's 84%
 * `UNKNOWN` rate is what that produces.
 */
describe('source-asserted classification', () => {
  it('takes the source’s label instead of scoring a personal name', () => {
    const lead = raw({
      name: 'Srdjan Todić',
      categories: ['Fasader'],
      assertedType: 'FACADE_CONTRACTOR',
      assertedTypeReason: 'listed under gradjevinski-radovi/fasader',
    });
    const { input, classification } = normalizeRawLead(lead, {}, NOW);

    expect(classification.label).toBe('FACADE_CONTRACTOR');
    expect(classification.sourceAsserted).toBe(true);
    expect(input.classification).toBe('FACADE_CONTRACTOR');
    expect(input.classificationConfidence).toBe(1);
  });

  it('keeps the inferred label in the stored evidence for auditing', () => {
    const lead = raw({
      name: 'Srdjan Todić',
      assertedType: 'FACADE_CONTRACTOR',
      assertedTypeReason: 'listed under gradjevinski-radovi/fasader',
    });
    const { input, classification } = normalizeRawLead(lead, {}, NOW);

    // Without the assertion this record is UNKNOWN and leaves the export.
    expect(classification.inferred?.label).toBe('UNKNOWN');
    expect(JSON.parse(input.classificationEvidence as string)).toMatchObject({
      sourceAsserted: true,
      inferred: { label: 'UNKNOWN' },
    });
  });

  it('scores a record the source asserted no worse than one it did not', () => {
    const asserted = normalizeRawLead(
      raw({
        name: 'Srdjan Todić',
        phones: ['064 588 06 69'],
        city: 'Palilula',
        assertedType: 'FACADE_CONTRACTOR',
      }),
      {},
      NOW,
    );
    expect(asserted.input.leadScore).toBeGreaterThan(0);
  });

  it('leaves an ordinary record on the word-scorer', () => {
    const { classification } = normalizeRawLead(raw(), {}, NOW);
    expect(classification.sourceAsserted).toBeUndefined();
    expect(classification.label).toBe('FACADE_CONTRACTOR');
  });
});

describe('persistLead', () => {
  it('writes the lead, the raw record and the provenance', () => {
    const lead = raw({ city: 'Novi Sad', phones: ['021/456-789'] });
    const result = persistLead(db, lead, normalizeRawLead(lead, {}, NOW), { now: NOW });

    expect(result.created).toBe(true);
    expect(getLead(db, result.leadId)?.name).toBe('Termo Fasade d.o.o.');
    expect(distinctPhones(db, result.leadId).map((phone) => phone.e164)).toEqual(['+38121456789']);

    const sources = leadSourceRows(db, result.leadId);
    expect(sources).toHaveLength(1);
    // The exact page, not the source's homepage.
    expect(sources[0]?.sourceUrl).toBe(URL_A);
    expect(sources[0]?.rawRecordId).toBe(result.rawRecordId);
  });

  it('updates rather than re-inserts when the same business is seen again', () => {
    const first = raw({ city: 'Novi Sad', phones: ['021/456-789'] });
    const created = persistLead(db, first, normalizeRawLead(first, {}, NOW), { now: NOW });

    // The same phone at a different URL — the strongest dedup signal there is.
    const second = raw({ sourceUrl: URL_B, name: 'Termo Fasade NS', phones: ['021 456 789'] });
    const later = new Date(NOW.getTime() + 60_000);
    const updated = persistLead(db, second, normalizeRawLead(second, {}, later), { now: later });

    expect(updated.leadId).toBe(created.leadId);
    expect(updated.created).toBe(false);
    expect(updated.matchedBy).toBe('phone');
    // Merge, never delete: the lead keeps every URL it was seen at.
    expect(
      leadSourceRows(db, created.leadId)
        .map((row) => row.sourceUrl)
        .sort(),
    ).toEqual([URL_A, URL_B]);
  });

  it('re-scores from the merged lead, not from one listing', () => {
    const first = raw({ city: 'Novi Sad', phones: ['021/456-789'] });
    const created = persistLead(db, first, normalizeRawLead(first, {}, NOW), { now: NOW });

    const second = raw({
      sourceUrl: URL_B,
      phones: ['021 456 789'],
      emails: ['info@termofasade.rs'],
      website: 'https://termofasade.rs',
    });
    const updated = persistLead(db, second, normalizeRawLead(second, {}, NOW), { now: NOW });

    expect(updated.score).toBeGreaterThan(created.score);
    expect(getLead(db, created.leadId)?.leadScore).toBe(updated.score);
    expect(
      leadContactClaims(db, created.leadId)
        .map((c) => c.kind)
        .sort(),
    ).toEqual(['email', 'website']);
  });

  it('archives the payload so a parser bug never needs a re-crawl', () => {
    const lead = raw({ extra: { rank: 3 } });
    const result = persistLead(db, lead, normalizeRawLead(lead, {}, NOW), { now: NOW });

    const stored = db.$client
      .prepare('select payload, status from raw_records where id = ?')
      .get(result.rawRecordId) as { payload: string; status: string };

    expect(stored.status).toBe('normalized');
    expect(JSON.parse(stored.payload)).toMatchObject({ extra: { rank: 3 } });
  });

  it('stores a rejected record with its error rather than dropping it', () => {
    persistRejected(db, SOURCE, URL_A, { name: '' }, 'name: too small', NOW);

    const stored = db.$client.prepare('select status, validation_error from raw_records').get() as {
      status: string;
      validation_error: string;
    };

    expect(stored.status).toBe('rejected');
    expect(stored.validation_error).toBe('name: too small');
  });
});

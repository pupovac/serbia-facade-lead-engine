/**
 * Repository tests, against a migrated in-memory database.
 *
 * The cases are the messy real ones this project actually hits: the same
 * fasader listed by two directories with different spellings and different
 * phone formatting, a landline and a mobile on one business, two branches of
 * one company in two cities, a near-duplicate name that must NOT be merged, a
 * re-run of an unchanged page, and an erasure request from a sole trader.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from './client.js';
import { foldForComparison } from '../text/fold.js';
import {
  attachSource,
  distinctPhones,
  distinctSourceCount,
  eraseLead,
  fieldConflicts,
  findByDomain,
  findByEmail,
  findByNameAndCity,
  findByPhone,
  finishRun,
  getCrawlState,
  getLead,
  isPhoneErased,
  leadCategories,
  leadContactClaims,
  leadPhoneClaims,
  leadSourceRows,
  promoteFieldValue,
  recordMerge,
  resolveLead,
  revertMerge,
  saveCrawlState,
  saveRawRecord,
  startRun,
  upsertLead,
  upsertSource,
  type LeadInput,
  type Provenance,
} from './repo.js';
import { crawlRuns, leadFieldValues, leads, rawRecords } from './schema.js';
import { eq } from 'drizzle-orm';

let db: Db;

/** The two directories used throughout: both real sources from the Stage 1 registry. */
const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/termo-izolacija-zvucna-izolacija-novi-sad',
};
const NAVIDIKU: Provenance = {
  sourceId: 'navidiku-rs',
  sourceUrl: 'https://www.navidiku.rs/firme/fasaderski-radovi/novi-sad',
};

function lead(name: string, overrides: Partial<LeadInput> = {}): LeadInput {
  return { name, nameNormalized: foldForComparison(name), ...overrides };
}

beforeEach(() => {
  db = openTestDatabase();
  for (const [id, name] of [
    ['portal-srbija', 'Portal Srbija'],
    ['navidiku-rs', 'Na vidiku'],
    ['austrotherm-distributeri', 'Austrotherm distributeri'],
  ] as const) {
    upsertSource(db, { id, name, url: `https://${id}.rs`, category: 'test' });
  }
});

afterEach(() => {
  closeDatabase(db);
});

/* -------------------------------------------------------------------------- */

describe('upsertLead — first sighting', () => {
  it('stores a lead with only a name, a city and a phone', () => {
    const result = upsertLead(
      db,
      lead('Fasade Novak', {
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        cityRaw: 'Novi Sad',
        phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
      }),
      PORTAL,
    );

    expect(result.created).toBe(true);
    expect(result.matchedBy).toBeNull();
    expect(result.phonesAdded).toBe(1);

    const stored = getLead(db, result.leadId);
    expect(stored?.name).toBe('Fasade Novak');
    expect(stored?.classification).toBe('UNCLASSIFIED');
    expect(stored?.leadScore).toBe(0);
    expect(leadSourceRows(db, result.leadId)).toHaveLength(1);
  });

  it('keeps the raw phone string exactly as the source published it', () => {
    const { leadId } = upsertLead(
      db,
      lead('Termo Fasada Čačak', {
        phones: [
          { e164: '+381641234567', raw: '064/123-4567', type: 'mobile' },
          { e164: '+38132345678', raw: '032/345-678', type: 'landline' },
        ],
      }),
      PORTAL,
    );

    const claims = leadPhoneClaims(db, leadId);
    expect(claims.map((c) => c.raw).sort()).toEqual(['032/345-678', '064/123-4567']);
    expect(claims.map((c) => c.type).sort()).toEqual(['landline', 'mobile']);
  });

  it('keeps a number libphonenumber rejected instead of discarding the lead', () => {
    const { leadId } = upsertLead(
      db,
      lead('Stovarište Kršumlija', {
        phones: [{ e164: '+38111', raw: 'T Kršumlija', valid: false }],
      }),
      { ...PORTAL, sourceId: 'austrotherm-distributeri' },
    );

    const [claim] = leadPhoneClaims(db, leadId);
    expect(claim?.valid).toBe(false);
    expect(claim?.raw).toBe('T Kršumlija');
    expect(getLead(db, leadId)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('upsertLead — attaching a second sighting', () => {
  it('matches on the normalized phone even when the raw formatting differs', () => {
    const first = upsertLead(
      db,
      lead('Fasade Novak', { phones: [{ e164: '+381641234567', raw: '064/123-4567' }] }),
      PORTAL,
    );
    const second = upsertLead(
      db,
      lead('FASADE NOVAK DOO', { phones: [{ e164: '+381641234567', raw: '+381 64 123 4567' }] }),
      NAVIDIKU,
    );

    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe('phone');
    expect(second.leadId).toBe(first.leadId);

    // One number, two raw spellings, two corroborating sources.
    const [phone] = distinctPhones(db, first.leadId);
    expect(phone?.e164).toBe('+381641234567');
    expect(phone?.rawVariants).toEqual(['064/123-4567', '+381 64 123 4567']);
    expect(phone?.sourceIds).toEqual(['portal-srbija', 'navidiku-rs']);
    expect(distinctSourceCount(db, first.leadId)).toBe(2);
  });

  it('matches on the website domain when no phone is shared', () => {
    const first = upsertLead(
      db,
      lead('Izomonter', {
        contacts: [{ kind: 'website', value: 'https://izomonter.rs/', domain: 'izomonter.rs' }],
      }),
      PORTAL,
    );
    const second = upsertLead(
      db,
      lead('Izomonter d.o.o.', {
        contacts: [
          { kind: 'website', value: 'http://www.izomonter.rs/kontakt', domain: 'izomonter.rs' },
        ],
        phones: [{ e164: '+381219876543', raw: '021/987-6543', type: 'landline' }],
      }),
      NAVIDIKU,
    );

    expect(second.matchedBy).toBe('website_domain');
    expect(second.leadId).toBe(first.leadId);
    expect(findByDomain(db, 'izomonter.rs')?.id).toBe(first.leadId);
  });

  it('matches on the email address', () => {
    const first = upsertLead(
      db,
      lead('Termodom', { contacts: [{ kind: 'email', value: 'office@termodom.rs' }] }),
      PORTAL,
    );
    const second = upsertLead(
      db,
      lead('Termo Dom', { contacts: [{ kind: 'email', value: 'office@termodom.rs' }] }),
      NAVIDIKU,
    );
    expect(second.matchedBy).toBe('email');
    expect(findByEmail(db, 'office@termodom.rs')?.id).toBe(first.leadId);
  });

  it('matches on name + city only when the folded names are identical', () => {
    const cacak = upsertLead(db, lead('Fasada Plus', { cityId: 'cacak' }), PORTAL);

    // Same business, spelled with diacritics folded away by the caller.
    const again = upsertLead(db, lead('fasada plus', { cityId: 'cacak' }), NAVIDIKU);
    expect(again.leadId).toBe(cacak.leadId);
    expect(again.matchedBy).toBe('name_city');

    // A near-duplicate name is NOT the same business.
    const nearDuplicate = upsertLead(db, lead('Fasada Plus Company', { cityId: 'cacak' }), PORTAL);
    expect(nearDuplicate.created).toBe(true);
    expect(nearDuplicate.leadId).not.toBe(cacak.leadId);
  });

  it('treats two branches of one company in two cities as two leads', () => {
    const novisad = upsertLead(db, lead('Gradnja Komerc', { cityId: 'novi-sad' }), PORTAL);
    const nis = upsertLead(db, lead('Gradnja Komerc', { cityId: 'nis' }), PORTAL);

    expect(nis.created).toBe(true);
    expect(nis.leadId).not.toBe(novisad.leadId);
    expect(findByNameAndCity(db, 'gradnja komerc', 'nis')?.id).toBe(nis.leadId);
  });

  it('does not match on a name alone when the incoming record has no city', () => {
    const known = upsertLead(db, lead('Fasaderski Radovi Petrović', { cityId: 'beograd' }), PORTAL);
    const cityless = upsertLead(db, lead('Fasaderski Radovi Petrović'), NAVIDIKU);
    expect(cityless.created).toBe(true);
    expect(cityless.leadId).not.toBe(known.leadId);
  });
});

/* -------------------------------------------------------------------------- */

describe('upsertLead — fill blanks, never clobber', () => {
  it('fills a field the stored lead did not have', () => {
    const first = upsertLead(
      db,
      lead('Fasade Novak', { phones: [{ e164: '+381641234567', raw: '064 123 4567' }] }),
      PORTAL,
    );
    upsertLead(
      db,
      lead('Fasade Novak', {
        phones: [{ e164: '+381641234567', raw: '064 123 4567' }],
        address: 'Bulevar oslobođenja 12',
        cityId: 'novi-sad',
        cityRaw: 'Novi Sad',
      }),
      NAVIDIKU,
    );

    const stored = getLead(db, first.leadId);
    expect(stored?.address).toBe('Bulevar oslobođenja 12');
    expect(stored?.cityId).toBe('novi-sad');
  });

  it('records a disagreement instead of overwriting the stored value', () => {
    const first = upsertLead(
      db,
      lead('Fasader Plus d.o.o.', {
        address: 'Bulevar oslobođenja 12',
        phones: [{ e164: '+381641234567', raw: '064 123 4567' }],
      }),
      PORTAL,
    );
    const second = upsertLead(
      db,
      lead('FASADER PLUS DOO', {
        address: 'Bulevar oslobodjenja 12a',
        phones: [{ e164: '+381641234567', raw: '064 123 4567' }],
      }),
      NAVIDIKU,
    );

    expect(second.conflictsRecorded).toBe(2); // name and address
    const stored = getLead(db, first.leadId);
    expect(stored?.name).toBe('Fasader Plus d.o.o.');
    expect(stored?.address).toBe('Bulevar oslobođenja 12');

    const conflicts = fieldConflicts(db, first.leadId);
    const nameConflict = conflicts.find((c) => c.field === 'name');
    expect(nameConflict?.current).toBe('Fasader Plus d.o.o.');
    expect(nameConflict?.claims.map((c) => c.value).sort()).toEqual([
      'FASADER PLUS DOO',
      'Fasader Plus d.o.o.',
    ]);
    // Both claims keep their own provenance.
    expect(nameConflict?.claims.map((c) => c.sourceId).sort()).toEqual([
      'navidiku-rs',
      'portal-srbija',
    ]);
  });

  it('does not record a conflict for the same value seen twice', () => {
    upsertLead(db, lead('Termo Fasada', { cityId: 'nis' }), PORTAL);
    const second = upsertLead(db, lead('Termo Fasada', { cityId: 'nis' }), NAVIDIKU);
    expect(second.conflictsRecorded).toBe(0);
    expect(fieldConflicts(db, second.leadId)).toEqual([]);
  });

  it('upgrades UNKNOWN to a real classification but never re-classifies', () => {
    const first = upsertLead(
      db,
      lead('Stovarište Beton', { phones: [{ e164: '+381113334444', raw: '011/333-4444' }] }),
      PORTAL,
    );
    upsertLead(
      db,
      lead('Stovarište Beton', {
        phones: [{ e164: '+381113334444', raw: '011/333-4444' }],
        classification: 'CONSTRUCTION_MATERIAL_STORE',
        classificationConfidence: 0.9,
      }),
      NAVIDIKU,
    );
    expect(getLead(db, first.leadId)?.classification).toBe('CONSTRUCTION_MATERIAL_STORE');

    upsertLead(
      db,
      lead('Stovarište Beton', {
        phones: [{ e164: '+381113334444', raw: '011/333-4444' }],
        classification: 'FACADE_CONTRACTOR',
      }),
      PORTAL,
    );
    expect(getLead(db, first.leadId)?.classification).toBe('CONSTRUCTION_MATERIAL_STORE');
  });

  it('promotes a claimed value on request and keeps the loser with its provenance', () => {
    const { leadId } = upsertLead(
      db,
      lead('Fasader Plus d.o.o.', { phones: [{ e164: '+381641234567', raw: '064 123 4567' }] }),
      PORTAL,
    );
    upsertLead(
      db,
      lead('Fasader Plus DOO Novi Sad', {
        phones: [{ e164: '+381641234567', raw: '064 123 4567' }],
      }),
      NAVIDIKU,
    );

    promoteFieldValue(db, leadId, 'name', 'Fasader Plus DOO Novi Sad');

    const stored = getLead(db, leadId);
    expect(stored?.name).toBe('Fasader Plus DOO Novi Sad');
    expect(stored?.nameNormalized).toBe(foldForComparison('Fasader Plus DOO Novi Sad'));

    const claims = db
      .select()
      .from(leadFieldValues)
      .where(eq(leadFieldValues.leadId, leadId))
      .all()
      .filter((c) => c.field === 'name');
    expect(claims).toHaveLength(2);
    expect(claims.filter((c) => c.isCurrent).map((c) => c.value)).toEqual([
      'Fasader Plus DOO Novi Sad',
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe('the APR activity category', () => {
  it('stores the code and its name, and records both as source claims', () => {
    const result = upsertLead(
      db,
      lead('ACA LAZAREVIĆ PR ACALEND STUBLINE', {
        activityCode: '4331',
        activityName: 'Malterisanje',
        phones: [{ e164: '+381643637451', raw: '+381.(0)64.3637451' }],
      }),
      PORTAL,
    );

    const stored = getLead(db, result.leadId);
    expect(stored?.activityCode).toBe('4331');
    expect(stored?.activityName).toBe('Malterisanje');

    // Per-field provenance, like every other single-valued fact: the claim
    // carries who said it and at which URL.
    const claims = db
      .select()
      .from(leadFieldValues)
      .where(eq(leadFieldValues.leadId, result.leadId))
      .all()
      .filter((row) => row.field === 'activity_code' || row.field === 'activity_name');
    expect(claims.map((row) => row.value).sort()).toEqual(['4331', 'Malterisanje']);
    expect(claims.every((row) => row.sourceId === 'portal-srbija')).toBe(true);
    expect(claims.every((row) => row.isCurrent)).toBe(true);
  });

  it('leaves both columns null for a source that publishes no activity code', () => {
    // The normal case, and it must stay the normal case: nothing is backfilled
    // and no adapter is obliged to have an opinion.
    const result = upsertLead(db, lead('Fasade Novak'), PORTAL);
    const stored = getLead(db, result.leadId);
    expect(stored?.activityCode).toBeNull();
    expect(stored?.activityName).toBeNull();
  });

  it('records a disagreement between two registers instead of overwriting one', () => {
    // FUZZ-45 measured the site's own filing and APR's open data disagreeing on
    // 52 of 329 records. Neither wins here — the conflict is the finding.
    const first = upsertLead(
      db,
      lead('MET INŽENJERING 021 DOO KULA', {
        activityCode: '3832',
        phones: [{ e164: '+381655665605', raw: '+381 65 5665605' }],
      }),
      PORTAL,
    );
    const second = upsertLead(
      db,
      lead('MET INŽENJERING 021 DOO KULA', {
        activityCode: '2364',
        phones: [{ e164: '+381655665605', raw: '+381 65 5665605' }],
      }),
      NAVIDIKU,
    );

    expect(getLead(db, first.leadId)?.activityCode).toBe('3832');
    const conflict = fieldConflicts(db, second.leadId).find((c) => c.field === 'activity_code');
    expect(conflict?.current).toBe('3832');
    expect(conflict?.claims.map((c) => c.value).sort()).toEqual(['2364', '3832']);
  });
});

describe('incremental re-runs', () => {
  it('updates instead of re-inserting when the same page is scraped again', () => {
    const day1 = new Date('2026-08-01T09:00:00Z');
    const day2 = new Date('2026-08-08T09:00:00Z');
    const input = lead('Fasade Novak', {
      cityId: 'novi-sad',
      phones: [{ e164: '+381641234567', raw: '064/123-4567' }],
    });

    const first = upsertLead(db, input, { ...PORTAL, seenAt: day1 });
    const second = upsertLead(db, input, { ...PORTAL, seenAt: day2 });

    expect(second.leadId).toBe(first.leadId);
    expect(second.phonesAdded).toBe(0);
    expect(db.select().from(leads).all()).toHaveLength(1);
    expect(leadPhoneClaims(db, first.leadId)).toHaveLength(1);

    const [source] = leadSourceRows(db, first.leadId);
    expect(source?.timesSeen).toBe(2);
    expect(source?.firstSeenAt.toISOString()).toBe(day1.toISOString());
    expect(source?.lastSeenAt.toISOString()).toBe(day2.toISOString());

    const stored = getLead(db, first.leadId);
    expect(stored?.firstSeenAt.toISOString()).toBe(day1.toISOString());
    expect(stored?.lastSeenAt.toISOString()).toBe(day2.toISOString());
  });

  it('keeps one row per source URL — a business on three pages is three sightings', () => {
    const { leadId } = upsertLead(db, lead('Gradnja Komerc', { cityId: 'beograd' }), PORTAL);
    attachSource(db, leadId, {
      sourceId: 'portal-srbija',
      sourceUrl: 'https://www.portal-srbija.com/hidroizolacija-beograd',
    });
    attachSource(db, leadId, {
      sourceId: 'navidiku-rs',
      sourceUrl: 'https://www.navidiku.rs/firme/fasade/beograd',
    });

    expect(leadSourceRows(db, leadId)).toHaveLength(3);
    expect(distinctSourceCount(db, leadId)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('raw records', () => {
  it('stores the untouched payload and bumps seen_count on an unchanged re-scrape', () => {
    const payload = JSON.stringify({ naziv: 'Fasade Novak', telefon: '064/123-4567' });
    const first = saveRawRecord(db, {
      sourceId: 'portal-srbija',
      sourceUrl: PORTAL.sourceUrl,
      payload,
    });
    const again = saveRawRecord(db, {
      sourceId: 'portal-srbija',
      sourceUrl: PORTAL.sourceUrl,
      payload,
    });

    expect(again.id).toBe(first.id);
    expect(again.seenCount).toBe(2);
    expect(db.select().from(rawRecords).all()).toHaveLength(1);
    expect(JSON.parse(again.payload)).toEqual({ naziv: 'Fasade Novak', telefon: '064/123-4567' });
  });

  it('keeps a record that failed validation, with its error', () => {
    const stored = saveRawRecord(db, {
      sourceId: 'austrotherm-distributeri',
      sourceUrl: 'https://www.austrotherm.rs/distributeri',
      payload: JSON.stringify({ name: 'Kršumlija', phone: 'T Kršumlija' }),
      status: 'rejected',
      validationError: 'phone: not a Serbian number',
    });
    expect(stored.status).toBe('rejected');
    expect(stored.validationError).toContain('not a Serbian number');
  });
});

/* -------------------------------------------------------------------------- */

describe('crawl bookkeeping', () => {
  it('records a run and its statistics', () => {
    const runId = startRun(db, 'portal-srbija', { trigger: 'scheduled', scope: '{"tier":1}' });
    finishRun(db, runId, 'completed', {
      requestsMade: 49,
      recordsEmitted: 108,
      recordsRejected: 2,
      leadsCreated: 90,
      leadsUpdated: 18,
    });

    const [run] = db.select().from(crawlRuns).where(eq(crawlRuns.id, runId)).all();
    expect(run?.status).toBe('completed');
    expect(run?.recordsEmitted).toBe(108);
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it('remembers where a scope got to so the next run resumes', () => {
    saveCrawlState(db, 'portal-srbija', 'category:termo-izolacija|city:novi-sad', {
      cursor: 'page=3',
      status: 'in_progress',
    });
    expect(
      getCrawlState(db, 'portal-srbija', 'category:termo-izolacija|city:novi-sad')?.cursor,
    ).toBe('page=3');

    saveCrawlState(db, 'portal-srbija', 'category:termo-izolacija|city:novi-sad', {
      cursor: null,
      status: 'done',
    });
    const state = getCrawlState(db, 'portal-srbija', 'category:termo-izolacija|city:novi-sad');
    expect(state?.status).toBe('done');
    expect(state?.attempts).toBe(2);
    expect(state?.completedAt).toBeInstanceOf(Date);
  });
});

/* -------------------------------------------------------------------------- */

describe('merge', () => {
  /** Two records of one business that share nothing exact, so only a merge unites them. */
  function twoUnlinkedSightings() {
    const survivor = upsertLead(
      db,
      lead('Fasade Novak', {
        cityId: 'novi-sad',
        phones: [{ e164: '+381641234567', raw: '064/123-4567', type: 'mobile' }],
      }),
      PORTAL,
    );
    const duplicate = upsertLead(
      db,
      lead('Fasade Novak SZR', {
        cityId: 'novi-sad',
        address: 'Bulevar oslobođenja 12',
        phones: [{ e164: '+381219876543', raw: '021/987-6543', type: 'landline' }],
        contacts: [{ kind: 'email', value: 'novak@fasade.rs', domain: 'fasade.rs' }],
      }),
      NAVIDIKU,
    );
    return { survivor: survivor.leadId, duplicate: duplicate.leadId };
  }

  it('keeps every phone, every contact and every source URL', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    const result = recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'address',
      signalValue: 'Bulevar oslobođenja 12, Novi Sad',
      score: 0.82,
    });

    expect(result.phonesMoved).toBe(1);
    expect(
      distinctPhones(db, survivor)
        .map((p) => p.e164)
        .sort(),
    ).toEqual(['+381219876543', '+381641234567']);
    expect(leadContactClaims(db, survivor).map((c) => c.value)).toEqual(['novak@fasade.rs']);
    expect(
      leadSourceRows(db, survivor)
        .map((s) => s.sourceId)
        .sort(),
    ).toEqual(['navidiku-rs', 'portal-srbija']);
    expect(leadSourceRows(db, duplicate)).toHaveLength(0);
  });

  it('leaves a tombstone so the merged-away id still resolves', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'name_city',
      signalValue: 'fasade novak|novi-sad',
    });

    const tombstone = getLead(db, duplicate);
    expect(tombstone).toBeDefined();
    expect(tombstone?.mergedIntoId).toBe(survivor);
    expect(tombstone?.status).toBe('merged');
    expect(resolveLead(db, duplicate)?.id).toBe(survivor);
    // A later sighting of the merged-away lead's phone lands on the survivor.
    expect(findByPhone(db, '+381219876543')?.id).toBe(survivor);
  });

  it('fills the survivor from the merged lead but does not overwrite it', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'manual',
      signalValue: 'reviewer',
      actor: 'reviewer:1',
    });

    const stored = getLead(db, survivor);
    expect(stored?.address).toBe('Bulevar oslobođenja 12'); // inherited — the survivor had none
    expect(stored?.name).toBe('Fasade Novak'); // kept — the survivor had one
  });

  it('records why the merge happened', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    const { mergeLogId } = recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'phone',
      signalValue: '+381641234567',
      score: 1,
    });
    expect(mergeLogId).toBeGreaterThan(0);
  });

  it('refuses to merge a lead into itself or to re-merge a tombstone', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    expect(() =>
      recordMerge(db, {
        survivingLeadId: survivor,
        mergedLeadId: survivor,
        signal: 'manual',
        signalValue: 'x',
      }),
    ).toThrow(/itself/);

    recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'manual',
      signalValue: 'x',
    });
    expect(() =>
      recordMerge(db, {
        survivingLeadId: survivor,
        mergedLeadId: duplicate,
        signal: 'manual',
        signalValue: 'x',
      }),
    ).toThrow(/already merged/);
  });

  it('collapses a claim the survivor already had, and restores it on revert', () => {
    const phone = { e164: '+381181112222', raw: '018/111-2222', type: 'landline' as const };
    const a = upsertLead(db, lead('Termo Fasada A', { cityId: 'nis', phones: [phone] }), PORTAL);
    // Same number, same source, on a second lead — `leadId` bypasses matching,
    // which is how the merge engine and the review UI address a known lead.
    const b = upsertLead(db, lead('Termo Fasada B', { cityId: 'nis' }), NAVIDIKU);
    upsertLead(db, lead('Termo Fasada B', { leadId: b.leadId, phones: [phone] }), PORTAL);
    expect(leadPhoneClaims(db, b.leadId)).toHaveLength(1);

    const result = recordMerge(db, {
      survivingLeadId: a.leadId,
      mergedLeadId: b.leadId,
      signal: 'phone',
      signalValue: phone.e164,
    });

    // The identical (number, source) claim is absorbed, not duplicated…
    expect(result.phonesMoved).toBe(0);
    expect(result.duplicatesAbsorbed).toBeGreaterThan(0);
    expect(leadPhoneClaims(db, a.leadId)).toHaveLength(1);

    // …and comes back when the merge is undone.
    revertMerge(db, result.mergeLogId);
    expect(leadPhoneClaims(db, a.leadId).map((c) => c.e164)).toEqual([phone.e164]);
    expect(leadPhoneClaims(db, b.leadId).map((c) => c.e164)).toEqual([phone.e164]);
  });

  it('reverts a merge, putting both leads back as they were', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    const before = getLead(db, survivor);
    const { mergeLogId } = recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'address',
      signalValue: 'Bulevar oslobođenja 12, Novi Sad',
    });

    revertMerge(db, mergeLogId, 'two branches, not one business');

    const restoredSurvivor = getLead(db, survivor);
    expect(restoredSurvivor?.address).toBe(before?.address ?? null);
    expect(distinctPhones(db, survivor).map((p) => p.e164)).toEqual(['+381641234567']);

    const restoredDuplicate = getLead(db, duplicate);
    expect(restoredDuplicate?.mergedIntoId).toBeNull();
    expect(distinctPhones(db, duplicate).map((p) => p.e164)).toEqual(['+381219876543']);
    expect(leadContactClaims(db, duplicate).map((c) => c.value)).toEqual(['novak@fasade.rs']);
    expect(leadSourceRows(db, duplicate)).toHaveLength(1);
    expect(findByPhone(db, '+381219876543')?.id).toBe(duplicate);
  });

  it('refuses to revert the same merge twice', () => {
    const { survivor, duplicate } = twoUnlinkedSightings();
    const { mergeLogId } = recordMerge(db, {
      survivingLeadId: survivor,
      mergedLeadId: duplicate,
      signal: 'manual',
      signalValue: 'x',
    });
    revertMerge(db, mergeLogId);
    expect(() => revertMerge(db, mergeLogId)).toThrow(/already reverted/);
  });
});

/* -------------------------------------------------------------------------- */

describe('erasure (ZZPL)', () => {
  it('deletes the business everywhere and blocks its number from coming back', () => {
    const { leadId } = upsertLead(
      db,
      lead('Fasader Marko PR', {
        cityId: 'kragujevac',
        phones: [{ e164: '+381641112222', raw: '064/111-2222', type: 'mobile' }],
        contacts: [{ kind: 'email', value: 'marko@example.rs', domain: 'example.rs' }],
      }),
      PORTAL,
    );
    const raw = saveRawRecord(db, {
      sourceId: 'portal-srbija',
      sourceUrl: PORTAL.sourceUrl,
      payload: JSON.stringify({ telefon: '064/111-2222' }),
      leadId,
    });
    expect(raw.leadId).toBe(leadId);

    const result = eraseLead(db, leadId, { reason: 'data subject request', requestedBy: 'REQ-7' });

    expect(getLead(db, leadId)).toBeUndefined();
    expect(findByPhone(db, '+381641112222')).toBeUndefined();
    expect(db.select().from(rawRecords).all()).toHaveLength(0);
    expect(result.rowsDeleted['lead_phones']).toBe(1);
    expect(result.phonesBlocked).toBe(1);
    expect(isPhoneErased(db, '+381641112222')).toBe(true);
    expect(isPhoneErased(db, '+381649998888')).toBe(false);
  });

  it('leaves an audit trail that holds no personal data', () => {
    const { leadId } = upsertLead(
      db,
      lead('Fasader Marko PR', { phones: [{ e164: '+381641112222', raw: '064/111-2222' }] }),
      PORTAL,
    );
    eraseLead(db, leadId, { reason: 'data subject request' });

    const entries = db.$client.prepare('select * from erasure_log').all() as Record<
      string,
      unknown
    >[];
    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('381641112222');
    expect(serialized).not.toContain('Marko');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * `leadCategories` — the two joins that make a re-grade see what the first
 * pass saw. Both cases below are real shapes from the FUZZ-22 pilot, and both
 * were bugs before they were tests.
 */
describe('leadCategories', () => {
  const AUSTROTHERM_URL = 'https://www.austrotherm.rs/distributeri';
  const AUSTROTHERM: Provenance = {
    sourceId: 'austrotherm-distributeri',
    sourceUrl: AUSTROTHERM_URL,
  };

  beforeEach(() => {
    upsertSource(db, {
      id: 'austrotherm-distributeri',
      name: 'Austrotherm distributeri',
      url: AUSTROTHERM_URL,
      category: 'test',
    });
    upsertSource(db, {
      id: 'overture-places',
      name: 'Overture Maps',
      url: 'https://overturemaps.org',
      category: 'test',
    });
  });

  const raw = (sourceId: string, sourceUrl: string, name: string, categories: string[]): void => {
    saveRawRecord(db, {
      sourceId,
      sourceUrl,
      payload: JSON.stringify({ sourceId, sourceUrl, name, categories }),
    });
  };

  it('reads the categories the business was filed under', () => {
    raw('portal-srbija', PORTAL.sourceUrl, 'Stovarište Gradnja', ['Stovarišta', 'Boje i lakovi']);
    const { leadId } = upsertLead(db, lead('Stovarište Gradnja'), PORTAL);
    expect(leadCategories(db, leadId)).toStrictEqual(['Stovarišta', 'Boje i lakovi']);
  });

  it('does not hand one business the categories of everyone else on the same page', () => {
    // The Austrotherm distributor list is 292 businesses behind one URL. A
    // join on `(source_id, source_url)` alone gives every one of them every
    // other one's categories.
    raw('austrotherm-distributeri', AUSTROTHERM_URL, '21 MAJ', ['Austrotherm distributer']);
    raw('austrotherm-distributeri', AUSTROTHERM_URL, 'MILJIĆ', ['EPS / stiropor']);
    const { leadId } = upsertLead(db, lead('21 MAJ'), AUSTROTHERM);

    expect(leadCategories(db, leadId)).toStrictEqual(['Austrotherm distributer']);
  });

  it('finds the categories a merged-in source published under a different name', () => {
    // Pilot lead 605: `Miljić TR` on Overture, `MILJIĆ` on Austrotherm — and
    // Austrotherm is the source that says it sells `građevinski materijal`.
    // Matching `leads.name` alone loses the label on every re-grade.
    raw('austrotherm-distributeri', AUSTROTHERM_URL, 'MILJIĆ', ['građevinski materijal']);
    raw('overture-places', 'https://overturemaps.org/#1', 'Miljić TR', ['building_supply_store']);

    const { leadId } = upsertLead(db, lead('MILJIĆ'), AUSTROTHERM);
    upsertLead(
      db,
      { ...lead('Miljić TR'), leadId },
      {
        sourceId: 'overture-places',
        sourceUrl: 'https://overturemaps.org/#1',
      },
    );

    expect(leadCategories(db, leadId).sort()).toStrictEqual([
      'building_supply_store',
      'građevinski materijal',
    ]);
  });

  it('survives a payload it cannot parse rather than failing the re-grade', () => {
    saveRawRecord(db, {
      sourceId: 'portal-srbija',
      sourceUrl: PORTAL.sourceUrl,
      payload: 'not json at all',
    });
    const { leadId } = upsertLead(db, lead('Neka Firma'), PORTAL);
    expect(leadCategories(db, leadId)).toStrictEqual([]);
  });

  it('returns nothing when no raw record backs the lead', () => {
    const { leadId } = upsertLead(db, lead('Bez Sirovog Zapisa'), PORTAL);
    expect(leadCategories(db, leadId)).toStrictEqual([]);
  });
});

/**
 * The guard, tested at both ends: the pure counting, and the pass that writes
 * its verdicts to `shared_identifiers` and stops the insert path from
 * chain-merging on them.
 *
 * The case that matters is the asymmetric one. One fasader listed by eight
 * directories under eight spellings must keep his number — throwing it away
 * costs the project its strongest signal. Five unrelated companies on one
 * call-centre line must lose it — keeping it collapses all five into one row.
 * Both are "one number, many rows"; only the names tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from '../db/client.js';
import {
  activeLeadCount,
  getSharedIdentifier,
  identifierOccurrences,
  isQuarantined,
  quarantinedIdentifiers,
  setManualQuarantine,
  upsertLead,
  upsertSource,
  type IdentifierOccurrence,
  type LeadInput,
  type Provenance,
} from '../db/repo.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { ingestLead } from './ingest.js';
import {
  assessIdentifiers,
  countDistinctBusinesses,
  isSameBusinessName,
  loadQuarantine,
  neverAnIdentity,
  refreshQuarantine,
} from './quarantine.js';
import { QUARANTINE_LIMITS } from './weights.js';

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasaderski-radovi-beograd',
};

function lead(name: string, overrides: Partial<LeadInput> = {}): LeadInput {
  return { name, nameNormalized: normalizeCompanyName(name).ascii, ...overrides };
}

function occurrence(value: string, name: string, leadId: number): IdentifierOccurrence {
  return {
    kind: 'phone',
    value,
    leadId,
    name,
    nameNormalized: normalizeCompanyName(name).ascii,
  };
}

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

/* -------------------------------------------------------------------------- */
/* Counting businesses, not rows                                              */
/* -------------------------------------------------------------------------- */

describe('countDistinctBusinesses', () => {
  it('folds every spelling of one name into one business', () => {
    const { count } = countDistinctBusinesses([
      'Fasader Plus d.o.o.',
      'FASADER PLUS DOO',
      'Fasader Plus',
      'Fasader plus doo Novi Sad',
    ]);
    expect(count).toBe(1);
  });

  it('counts two surnames as two businesses', () => {
    const { count } = countDistinctBusinesses(['Fasade Marković', 'Fasade Marko']);
    expect(count).toBe(2);
  });

  it('folds a diacritic variant into its ASCII twin', () => {
    const { count } = countDistinctBusinesses([
      'Građevinski centar Milić',
      'Gradjevinski centar Milic',
    ]);
    expect(count).toBe(1);
  });

  it('keeps a representative name per business, for a human to judge by', () => {
    const { representatives } = countDistinctBusinesses([
      'Fasade Jovanović',
      'Fasade Jovanovic',
      'Stovarište Dunav',
    ]);
    expect(representatives).toEqual(['Fasade Jovanović', 'Stovarište Dunav']);
  });

  it('ignores a name that normalizes to nothing', () => {
    expect(countDistinctBusinesses(['', '   ', '...']).count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Values that are never an identity                                          */
/* -------------------------------------------------------------------------- */

describe('neverAnIdentity', () => {
  it('rejects a listing portal as a website identity', () => {
    expect(neverAnIdentity('website_domain', 'portal-srbija.com')).toBe('directory_owned');
    expect(neverAnIdentity('website_domain', 'www.navidiku.rs')).toBe('directory_owned');
  });

  it('rejects a directory-owned email address', () => {
    expect(neverAnIdentity('email', 'kontakt@011info.com')).toBe('directory_owned');
  });

  it('rejects a social network and a CDN as website identities', () => {
    expect(neverAnIdentity('website_domain', 'facebook.com')).toBe('infrastructure');
    expect(neverAnIdentity('website_domain', 'googleapis.com')).toBe('infrastructure');
  });

  it('rejects a free mailbox provider as a *domain*, and keeps the address', () => {
    expect(neverAnIdentity('website_domain', 'gmail.com')).toBe('infrastructure');
    // The mailbox is one business. Most fasaderi in this database are on one.
    expect(neverAnIdentity('email', 'fasade.petrovic@gmail.com')).toBeNull();
  });

  it('never rejects a phone structurally — only the counts can', () => {
    expect(neverAnIdentity('phone', '+381113334455')).toBeNull();
  });

  it('accepts a real business domain', () => {
    expect(neverAnIdentity('website_domain', 'fasaderplus.rs')).toBeNull();
    expect(neverAnIdentity('email', 'prodaja@fasaderplus.rs')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The verdicts                                                               */
/* -------------------------------------------------------------------------- */

describe('assessIdentifiers', () => {
  const switchboard = '+381113334455';

  it('leaves one business listed by eight directories alone', () => {
    const spellings = [
      'Fasader Plus d.o.o.',
      'FASADER PLUS DOO',
      'Fasader Plus',
      'Fasader plus Novi Sad',
      'FASADER PLUS',
      'Fasader Plus doo',
      'fasader plus',
      'Fasader Plus d.o.o. Novi Sad',
    ];
    const [spread] = assessIdentifiers(
      spellings.map((name, index) => occurrence(switchboard, name, index + 1)),
    );

    expect(spread?.distinctLeads).toBe(8);
    expect(spread?.distinctBusinesses).toBe(1);
    expect(spread?.quarantined).toBe(false);
  });

  it('quarantines a number five unrelated businesses publish', () => {
    const names = [
      'Fasade Jovanović',
      'Izolacija Nikolić',
      'Stovarište Dunav',
      'Termo Sistem',
      'Fasaderski radovi Zoran',
    ];
    expect(names.length).toBeGreaterThan(QUARANTINE_LIMITS.phone);

    const [spread] = assessIdentifiers(
      names.map((name, index) => occurrence(switchboard, name, index + 1)),
    );

    expect(spread?.distinctBusinesses).toBe(5);
    expect(spread?.quarantined).toBe(true);
    expect(spread?.reason).toBe('shared_across_businesses');
    expect(spread?.sampleNames).toContain('Fasade Jovanović');
  });

  it('leaves a number exactly at the limit alone', () => {
    const names = ['Fasade Jovanović', 'Izolacija Nikolić', 'Stovarište Dunav', 'Termo Sistem'];
    expect(names).toHaveLength(QUARANTINE_LIMITS.phone);

    const [spread] = assessIdentifiers(
      names.map((name, index) => occurrence(switchboard, name, index + 1)),
    );
    expect(spread?.quarantined).toBe(false);
  });

  it('quarantines a directory domain on its very first sighting', () => {
    const [spread] = assessIdentifiers([
      {
        kind: 'website_domain',
        value: 'portal-srbija.com',
        leadId: 1,
        name: 'Fasade Jovanović',
        nameNormalized: 'fasade jovanovic',
      },
    ]);
    expect(spread?.distinctBusinesses).toBe(1);
    expect(spread?.quarantined).toBe(true);
    expect(spread?.reason).toBe('directory_owned');
  });
});

/* -------------------------------------------------------------------------- */
/* The database pass                                                          */
/* -------------------------------------------------------------------------- */

describe('refreshQuarantine', () => {
  const switchboard = '+381113334455';

  const SWITCHBOARD_NAMES = [
    'Fasade Jovanović',
    'Izolacija Nikolić',
    'Stovarište Dunav',
    'Termo Sistem',
    'Fasaderski radovi Zoran',
  ];

  /** Five unrelated Belgrade businesses, all printing one listing service's line. */
  function seedSwitchboard(): void {
    for (const name of SWITCHBOARD_NAMES) {
      ingestLead(
        db,
        lead(name, {
          cityId: 'beograd',
          phones: [{ e164: switchboard, raw: '011/333-4455', type: 'landline' }],
        }),
        PORTAL,
      );
    }
  }

  it('does not let a shared number collapse five businesses at insert time', () => {
    seedSwitchboard();
    // The names say these are five businesses, so the shared number never gets
    // to attach one to another — and an attach could not have been undone.
    expect(activeLeadCount(db)).toBe(5);
  });

  it('collapses them when the name guard is not supplied — which is why it is', () => {
    for (const name of SWITCHBOARD_NAMES) {
      upsertLead(
        db,
        lead(name, {
          cityId: 'beograd',
          phones: [{ e164: switchboard, raw: '011/333-4455', type: 'landline' }],
        }),
        PORTAL,
      );
    }
    expect(activeLeadCount(db)).toBe(1);
  });

  it('still attaches the same business spelled differently', () => {
    for (const name of ['Fasader Plus d.o.o.', 'FASADER PLUS DOO', 'Fasader Plus']) {
      ingestLead(
        db,
        lead(name, {
          cityId: 'novi-sad',
          phones: [{ e164: '+381641112233', raw: '064/111-2233', type: 'mobile' }],
        }),
        PORTAL,
      );
    }
    expect(activeLeadCount(db)).toBe(1);
    expect(isSameBusinessName('Fasader Plus d.o.o.', 'FASADER PLUS DOO')).toBe(true);
  });

  it('writes the verdict, the counts and the sample names', () => {
    seedSwitchboard();
    const stats = refreshQuarantine(db);

    expect(stats.quarantined).toBe(1);
    expect(stats.byKind.phone).toBe(1);
    expect(stats.newlyQuarantined.map((spread) => spread.value)).toEqual([switchboard]);

    const row = getSharedIdentifier(db, 'phone', switchboard);
    expect(row?.quarantined).toBe(true);
    expect(row?.distinctLeads).toBe(5);
    expect(row?.distinctBusinesses).toBe(5);
    expect(JSON.parse(row?.sampleNames ?? '[]')).toContain('Stovarište Dunav');
  });

  it('is idempotent, and reports nothing newly quarantined the second time', () => {
    seedSwitchboard();
    const first = refreshQuarantine(db);
    const second = refreshQuarantine(db);

    expect(second.quarantined).toBe(first.quarantined);
    expect(second.newlyQuarantined).toHaveLength(0);
  });

  it('leaves one business listed under many spellings with its number', () => {
    for (const name of [
      'Fasader Plus d.o.o.',
      'FASADER PLUS DOO',
      'Fasader Plus',
      'Fasader plus doo Novi Sad',
      'FASADER PLUS',
    ]) {
      ingestLead(
        db,
        lead(name, {
          cityId: 'novi-sad',
          phones: [{ e164: '+381641112233', raw: '064/111-2233', type: 'mobile' }],
        }),
        PORTAL,
      );
    }

    refreshQuarantine(db);
    expect(isQuarantined(db, 'phone', '+381641112233')).toBe(false);
  });

  it('stops the insert path from matching on a quarantined number', () => {
    seedSwitchboard();
    refreshQuarantine(db);
    const before = activeLeadCount(db);

    const sixth = ingestLead(
      db,
      lead('Fasade Milošević', {
        cityId: 'beograd',
        phones: [{ e164: switchboard, raw: '011 333 4455', type: 'landline' }],
      }),
      PORTAL,
    );

    expect(sixth.created).toBe(true);
    expect(sixth.matchedBy).toBeNull();
    expect(activeLeadCount(db)).toBe(before + 1);
  });

  it('never writes a row for a value only one lead carries', () => {
    upsertLead(
      db,
      lead('Fasade Novak', {
        cityId: 'nis',
        phones: [{ e164: '+381641234567', raw: '064/123-4567' }],
      }),
      PORTAL,
    );
    refreshQuarantine(db);
    expect(getSharedIdentifier(db, 'phone', '+381641234567')).toBeUndefined();
  });

  it('counts a number carried by a merged-away lead once, not twice', () => {
    // Two directories, one business, one number: the second sighting attaches
    // to the first lead, so the number spans one business and stays trusted.
    upsertLead(
      db,
      lead('Fasade Novak', {
        cityId: 'nis',
        phones: [{ e164: '+381641234567', raw: '064/123-4567' }],
      }),
      PORTAL,
    );
    upsertLead(
      db,
      lead('FASADE NOVAK DOO', {
        cityId: 'nis',
        phones: [{ e164: '+381641234567', raw: '+381 64 123 4567' }],
      }),
      { ...PORTAL, sourceUrl: 'https://www.portal-srbija.com/other' },
    );

    const occurrences = identifierOccurrences(db, 'phone').filter(
      (row) => row.value === '+381641234567',
    );
    expect(occurrences).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* A human's verdict outranks the arithmetic                                  */
/* -------------------------------------------------------------------------- */

describe('manual quarantine', () => {
  it('blocks a number the counts have not caught yet', () => {
    setManualQuarantine(db, 'phone', '+381113334455', true, 'known call centre');
    expect(isQuarantined(db, 'phone', '+381113334455')).toBe(true);
    expect(quarantinedIdentifiers(db, 'phone')).toHaveLength(1);
  });

  it('releases a number the counts caught wrongly, and the pass does not undo it', () => {
    const number = '+381113334455';
    for (const name of [
      'Fasade Jovanović',
      'Izolacija Nikolić',
      'Stovarište Dunav',
      'Termo Sistem',
      'Fasaderski radovi Zoran',
    ]) {
      ingestLead(
        db,
        lead(name, {
          cityId: 'beograd',
          phones: [{ e164: number, raw: '011/333-4455', type: 'landline' }],
        }),
        PORTAL,
      );
    }
    refreshQuarantine(db);
    expect(isQuarantined(db, 'phone', number)).toBe(true);

    // One group of companies, six brands, one switchboard. A reviewer knows.
    setManualQuarantine(db, 'phone', number, false, 'one group, six brands');
    refreshQuarantine(db);

    expect(isQuarantined(db, 'phone', number)).toBe(false);
    // The counts are still refreshed — only the verdict is left alone.
    expect(getSharedIdentifier(db, 'phone', number)?.distinctBusinesses).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the verdicts back                                                  */
/* -------------------------------------------------------------------------- */

describe('loadQuarantine', () => {
  it('answers from the stored verdicts and the structural rules together', () => {
    setManualQuarantine(db, 'phone', '+381113334455', true);
    const quarantine = loadQuarantine(db);

    expect(quarantine.has('phone', '+381113334455')).toBe(true);
    expect(quarantine.has('phone', '+381641234567')).toBe(false);
    // Never stored, never counted, still refused.
    expect(quarantine.has('website_domain', 'portal-srbija.com')).toBe(true);
  });
});

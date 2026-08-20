/**
 * Which leads the crawler spends its requests on.
 *
 * The ordering is the whole test. A lead with a website and no phone has to
 * come first, ahead of a lead that is only missing an email, because the phone
 * is the deliverable and the request budget is finite — and the numbers that
 * decide it come from `src/lib/score`'s weight table rather than from a
 * preference expressed here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  openTestDatabase,
  saveCrawlState,
  upsertLead,
  upsertSource,
  type Db,
  type LeadInput,
  type Provenance,
} from '@/lib/db';
import { leadRecord } from '@/lib/dedup';
import { normalizeCompanyName } from '@/lib/normalize';
import { missingFields, selectTargets } from './targets.js';
import {
  ENRICHMENT_SOURCE_IDS,
  OWN_SITE_SOURCE,
  ensureEnrichmentSources,
  leadScopeKey,
} from './sources.js';
import { FIELD_GAIN } from './thresholds.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-20T12:00:00Z');

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasaderski-radovi-novi-sad',
  seenAt: new Date('2026-08-01T00:00:00Z'),
};

beforeEach(() => {
  db = openTestDatabase();
  upsertSource(db, {
    id: 'portal-srbija',
    name: 'Portal Srbija',
    url: 'https://www.portal-srbija.com',
    category: 'directory',
  });
  ensureEnrichmentSources(db, NOW);
});

afterEach(() => {
  closeDatabase(db);
});

function store(name: string, overrides: Partial<LeadInput> = {}): number {
  const input: LeadInput = {
    name,
    nameNormalized: normalizeCompanyName(name).ascii,
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    ...overrides,
  };
  return upsertLead(db, input, PORTAL).leadId;
}

describe('missingFields', () => {
  it('reports the blanks and nothing else', () => {
    const record = leadRecord({
      name: 'Mika Fasade',
      cityId: 'novi-sad',
      phones: ['+381641234567'],
    });
    expect(missingFields(record)).toEqual(['email', 'website', 'social', 'address']);
  });

  it('counts one social profile as enough', () => {
    const record = leadRecord({
      name: 'Mika Fasade',
      socialUrls: ['https://www.facebook.com/mikafasade'],
    });
    expect(missingFields(record)).not.toContain('social');
  });

  it('reports nothing for a complete lead', () => {
    const record = leadRecord({
      name: 'Mika Fasade',
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      addressNormalized: 'temerinska 12',
      phones: ['+381641234567'],
      emails: ['info@mikafasade.rs'],
      websiteDomains: ['mikafasade.rs'],
      socialUrls: ['https://www.instagram.com/mikafasade'],
    });
    expect(missingFields(record)).toEqual([]);
  });
});

describe('selectTargets', () => {
  it('puts the website-but-no-phone lead first, by a wide margin', () => {
    const onlyEmailMissing = store('Gradnja Plus', {
      phones: [{ e164: '+381642345678', raw: '064 234 5678', type: 'mobile' }],
      contacts: [
        {
          kind: 'website',
          value: 'https://gradnjaplus.rs',
          domain: 'gradnjaplus.rs',
        },
        { kind: 'facebook', value: 'https://www.facebook.com/gradnjaplus' },
      ],
      address: 'Futoška 45',
      addressNormalized: 'futoška 45',
    });
    const noPhone = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });

    const targets = selectTargets(db, { now: NOW });

    expect(targets.map((target) => target.leadId)).toEqual([noPhone, onlyEmailMissing]);
    expect(targets[0]?.potentialGain).toBeGreaterThan(FIELD_GAIN.phone);
    expect(targets[0]?.missing).toContain('phone');
  });

  it('skips a lead that has nothing left to gain', () => {
    store('Potpuna Firma', {
      address: 'Temerinska 12',
      addressNormalized: 'temerinska 12',
      phones: [{ e164: '+381641234567', raw: '064 123 4567', type: 'mobile' }],
      contacts: [
        { kind: 'email', value: 'info@potpuna.rs', domain: 'potpuna.rs' },
        { kind: 'website', value: 'https://potpuna.rs', domain: 'potpuna.rs' },
        { kind: 'instagram', value: 'https://www.instagram.com/potpuna' },
      ],
    });
    expect(selectTargets(db, { now: NOW })).toEqual([]);
  });

  it('carries the website as published, not just its registrable domain', () => {
    store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://www.mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const target = selectTargets(db, { now: NOW })[0];
    expect(target?.websites).toEqual(['https://www.mikafasade.rs']);
    expect(target?.record.websiteDomains).toEqual(['mikafasade.rs']);
  });

  it('names the city from the geo dataset so the search query can use it', () => {
    store('Mika Fasade', { cityId: 'novi-sad', municipalityId: 'novi-sad' });
    expect(selectTargets(db, { now: NOW })[0]?.cityName).toBe('Novi Sad');
  });

  it('splits the two paths on whether the lead has a website', () => {
    const withSite = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const withoutSite = store('Fasade Petrović');

    expect(selectTargets(db, { withWebsiteOnly: true, now: NOW }).map((t) => t.leadId)).toEqual([
      withSite,
    ]);
    expect(selectTargets(db, { withoutWebsiteOnly: true, now: NOW }).map((t) => t.leadId)).toEqual([
      withoutSite,
    ]);
  });

  it('honours an explicit lead list and a limit', () => {
    store('Mika Fasade');
    const second = store('Fasade Petrović');
    store('Gradnja Plus');

    expect(selectTargets(db, { leadIds: [second], now: NOW }).map((t) => t.leadId)).toEqual([
      second,
    ]);
    expect(selectTargets(db, { limit: 2, now: NOW })).toHaveLength(2);
  });

  it('leaves a merged-away tombstone alone', () => {
    const survivor = store('Mika Fasade');
    const merged = store('Fasade Petrović');
    db.$client.prepare('update leads set merged_into_id = ? where id = ?').run(survivor, merged);

    expect(selectTargets(db, { now: NOW }).map((t) => t.leadId)).toEqual([survivor]);
  });
});

describe('incremental runs', () => {
  it('skips a lead enrichment visited inside the staleness window', () => {
    const leadId = store('Mika Fasade');
    saveCrawlState(db, OWN_SITE_SOURCE, leadScopeKey(leadId), {
      status: 'done',
      seenAt: new Date(NOW.getTime() - 2 * DAY),
    });

    expect(
      selectTargets(db, { stalenessMs: 30 * DAY, sourceIds: ENRICHMENT_SOURCE_IDS, now: NOW }),
    ).toEqual([]);
    // Once the window has passed, it is a target again.
    expect(
      selectTargets(db, { stalenessMs: 1 * DAY, sourceIds: ENRICHMENT_SOURCE_IDS, now: NOW }),
    ).toHaveLength(1);
  });

  it('does not treat a visit by an ordinary source as an enrichment visit', () => {
    const leadId = store('Mika Fasade');
    saveCrawlState(db, 'portal-srbija', leadScopeKey(leadId), { status: 'done', seenAt: NOW });
    expect(
      selectTargets(db, { stalenessMs: 365 * DAY, sourceIds: ENRICHMENT_SOURCE_IDS, now: NOW }),
    ).toHaveLength(1);
  });

  it('comes back to a lead whose site had nothing on it, once the window passes', () => {
    // The reason incrementality is keyed on `crawl_state` and not on
    // `lead_sources`: this lead gained nothing, so it has no source row at all,
    // and a `lead_sources` check would re-crawl it on every single run.
    const leadId = store('Mika Fasade');
    saveCrawlState(db, OWN_SITE_SOURCE, leadScopeKey(leadId), { status: 'done', seenAt: NOW });

    expect(
      selectTargets(db, { stalenessMs: 30 * DAY, sourceIds: ENRICHMENT_SOURCE_IDS, now: NOW }),
    ).toEqual([]);
    expect(
      selectTargets(db, {
        stalenessMs: 30 * DAY,
        sourceIds: ENRICHMENT_SOURCE_IDS,
        now: new Date(NOW.getTime() + 31 * DAY),
      }),
    ).toHaveLength(1);
  });
});

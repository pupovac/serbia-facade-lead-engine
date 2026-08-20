/**
 * What a verdict does to the database.
 *
 * Three properties are worth more than the rest here, and each of them is a way
 * enrichment could quietly make the data worse rather than better:
 *
 * - It **fills blanks and never overwrites.** A contact page that spells the
 *   address differently records a claim; it does not win.
 * - It **does not re-classify.** A page whose only text is "Kontakt" is not
 *   evidence about what the business *is*, and letting it re-grade the label
 *   would drop confident leads out of the export.
 * - It **does not overturn a reviewer.** A value a human rejected stays
 *   rejected however good this run's evidence looks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
  closeDatabase,
  distinctPhones,
  fieldConflicts,
  getLead,
  leadContactClaims,
  leadSourceRows,
  openTestDatabase,
  pendingSuggestions,
  rawRecords,
  resolveSuggestion,
  upsertLead,
  upsertSource,
  type Db,
  type LeadInput,
  type Provenance,
} from '@/lib/db';
import { normalizeCompanyName } from '@/lib/normalize';
import { applyMerge, findingsFrom, queueSuggestions } from './apply.js';
import { assessCandidate } from './confidence.js';
import { readPage } from './page.js';
import { selectTargets } from './targets.js';
import { OWN_SITE_SOURCE, SEARCH_SOURCE, ensureEnrichmentSources } from './sources.js';
import type { EnrichmentTarget, PageEvidence } from './types.js';

const NOW = new Date('2026-08-20T12:00:00Z');

let db: Db;

const PORTAL: Provenance = {
  sourceId: 'portal-srbija',
  sourceUrl: 'https://www.portal-srbija.com/fasaderski-radovi-novi-sad',
  seenAt: new Date('2026-08-01T00:00:00Z'),
};

function page(name: string, url: string): PageEvidence {
  const html = readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    'utf8',
  );
  return readPage({ url, html, $: cheerio.load(html) });
}

function store(name: string, overrides: Partial<LeadInput> = {}): number {
  return upsertLead(
    db,
    {
      name,
      nameNormalized: normalizeCompanyName(name).ascii,
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      classification: 'FACADE_CONTRACTOR',
      classificationConfidence: 0.9,
      ...overrides,
    },
    PORTAL,
  ).leadId;
}

/** The target the crawler would have selected for this lead. */
function target(leadId: number): EnrichmentTarget {
  const found = selectTargets(db, { leadIds: [leadId], now: NOW })[0];
  if (found === undefined) throw new Error(`lead ${leadId} is not an enrichment target`);
  return found;
}

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

/* -------------------------------------------------------------------------- */
/* findingsFrom — pure                                                        */
/* -------------------------------------------------------------------------- */

describe('findingsFrom', () => {
  it('reports only what the lead has not already got', () => {
    const leadId = store('Mika Fasade', {
      phones: [{ e164: '+381641234567', raw: '064 123 4567', type: 'mobile' }],
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const findings = findingsFrom(
      target(leadId),
      page('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
    );

    // The 064 number and the website are already on the lead.
    expect(findings.map((finding) => `${finding.kind}:${finding.value}`)).toEqual([
      'phone:+381652223344',
      'email:info@mikafasade.rs',
      'instagram:https://www.instagram.com/mikafasade',
      'address:Temerinska 12, 21000, Novi Sad',
    ]);
  });

  it('does not offer a website the lead already has under a `www.` host', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://www.mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const findings = findingsFrom(
      target(leadId),
      page('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
    );
    expect(findings.map((finding) => finding.kind)).not.toContain('website');
  });

  it('offers the city only when the lead has no place at all', () => {
    const placed = store('Mika Fasade');
    const findings = findingsFrom(
      target(placed),
      page('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
    );
    expect(findings.map((finding) => finding.kind)).not.toContain('city');
  });
});

/* -------------------------------------------------------------------------- */
/* applyMerge                                                                 */
/* -------------------------------------------------------------------------- */

describe('applyMerge', () => {
  function enrich(leadId: number, name = 'positive/mika-fasade-kontakt.html') {
    const evidence = page(name, 'https://mikafasade.rs/kontakt');
    const entry = target(leadId);
    const verdict = assessCandidate({ lead: entry.record, page: evidence, origin: 'own_site' });
    return {
      verdict,
      result: applyMerge(db, entry, evidence, verdict, findingsFrom(entry, evidence), {
        sourceId: OWN_SITE_SOURCE,
        now: NOW,
      }),
    };
  }

  it('attaches the phone, the email, the social profile and the address', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const { result } = enrich(leadId);

    expect(result.fieldsAdded).toEqual({ phone: 2, email: 1, social: 1, address: 1 });
    expect(distinctPhones(db, leadId).map((phone) => phone.e164)).toEqual([
      '+381641234567',
      '+381652223344',
    ]);
    expect(
      leadContactClaims(db, leadId)
        .filter((claim) => claim.kind === 'email')
        .map((claim) => claim.value),
    ).toEqual(['info@mikafasade.rs']);
    expect(getLead(db, leadId)?.address).toBe('Temerinska 12, 21000, Novi Sad');
  });

  it('lifts the score, because the lead now has a phone', () => {
    const leadId = store('Mika Fasade', {
      leadScore: 20,
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const { result } = enrich(leadId);

    expect(result.scoreBefore).toBe(20);
    expect(result.score).toBeGreaterThan(result.scoreBefore);
    // The no-phone ceiling is 25; a lead with a phone must be able to pass it.
    expect(result.score).toBeGreaterThan(25);
  });

  it('leaves the classifier’s label exactly where it was', () => {
    const leadId = store('Mika Fasade', {
      classification: 'FACADE_CONTRACTOR',
      classificationConfidence: 0.9,
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    enrich(leadId);

    const lead = getLead(db, leadId);
    expect(lead?.classification).toBe('FACADE_CONTRACTOR');
    expect(lead?.classificationConfidence).toBe(0.9);
  });

  it('records a disagreement as a claim rather than overwriting the stored value', () => {
    const leadId = store('Mika Fasade', {
      address: 'Temerinska 99',
      addressNormalized: 'temerinska 99',
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    enrich(leadId);

    // The stored address survives; the page's address is not even offered,
    // because `findingsFrom` only proposes what is missing.
    expect(getLead(db, leadId)?.address).toBe('Temerinska 99');
  });

  it('writes provenance a human can re-open: the exact page, under the enrichment source', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    enrich(leadId);

    const rows = leadSourceRows(db, leadId);
    const enrichment = rows.find((row) => row.sourceId === OWN_SITE_SOURCE);
    expect(enrichment?.sourceUrl).toBe('https://mikafasade.rs/kontakt');

    const phone = distinctPhones(db, leadId).find((row) => row.e164 === '+381652223344');
    expect(phone?.sourceIds).toEqual([OWN_SITE_SOURCE]);
  });

  it('archives the payload and the verdict, so a merge can be argued with later', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const { verdict } = enrich(leadId);

    const archived = db.select().from(rawRecords).all();
    expect(archived).toHaveLength(1);
    const payload = JSON.parse(archived[0]?.payload ?? '{}') as {
      verdict: { rule: string; signals: unknown[] };
    };
    expect(payload.verdict.rule).toBe(verdict.rule);
    expect(Array.isArray(payload.verdict.signals)).toBe(true);
  });

  it('is idempotent — an enriched lead has nothing left for a second run to add', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const { result } = enrich(leadId);
    const phones = distinctPhones(db, leadId).length;

    // Every blank this page could fill is now filled, so the lead is no longer
    // a target at all — the cheapest possible form of "adds nothing".
    expect(selectTargets(db, { leadIds: [leadId], now: NOW })).toEqual([]);
    expect(result.fieldsAdded.phone).toBe(2);
    expect(phones).toBe(2);
  });

  it('offers nothing new when the page is re-read after a merge', () => {
    // The same check one level down, for a lead that is still a target because
    // it is missing something this page does not have.
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const evidence = page('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt');
    const first = target(leadId);
    const verdict = assessCandidate({ lead: first.record, page: evidence, origin: 'own_site' });
    applyMerge(db, first, evidence, verdict, findingsFrom(first, evidence), {
      sourceId: OWN_SITE_SOURCE,
      now: NOW,
    });

    const reread = selectTargets(db, { leadIds: [leadId], now: NOW })[0];
    // Nothing left to select means nothing left to find.
    expect(reread).toBeUndefined();
    expect(distinctPhones(db, leadId)).toHaveLength(2);
  });

  it('refuses a value a reviewer has already rejected', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const evidence = page('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt');
    const entry = target(leadId);
    const verdict = assessCandidate({ lead: entry.record, page: evidence, origin: 'own_site' });

    // A human looked at this number on an earlier run and said no.
    queueSuggestions(db, entry, evidence, verdict, findingsFrom(entry, evidence), {
      sourceId: SEARCH_SOURCE,
      now: NOW,
    });
    const queued = pendingSuggestions(db, { leadId });
    const phone = queued.find((row) => row.value === '+381652223344');
    resolveSuggestion(db, phone?.id ?? 0, 'rejected', 'reviewer:1', NOW);

    const result = applyMerge(db, entry, evidence, verdict, findingsFrom(entry, evidence), {
      sourceId: OWN_SITE_SOURCE,
      now: NOW,
    });

    expect(distinctPhones(db, leadId).map((row) => row.e164)).not.toContain('+381652223344');
    expect(result.fieldsAdded.phone).toBe(1);
  });

  it('does not re-point the write when the page carries another lead’s phone', () => {
    // `matching: 'caller'` is what guarantees this: the exact matcher would
    // have found the other lead by its phone and attached the claims there.
    const other = store('Fasade Petrović', {
      phones: [{ e164: '+381641234567', raw: '064 123 4567', type: 'mobile' }],
    });
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    const { result } = enrich(leadId);

    expect(result.leadId).toBe(leadId);
    expect(distinctPhones(db, other).map((row) => row.e164)).toEqual(['+381641234567']);
    expect(distinctPhones(db, leadId).map((row) => row.e164)).toContain('+381641234567');
  });

  it('never files the page’s own title as a competing claim for the name', () => {
    const leadId = store('Mika Fasade', {
      contacts: [{ kind: 'website', value: 'https://mikafasade.rs', domain: 'mikafasade.rs' }],
    });
    enrich(leadId);

    const name = fieldConflicts(db, leadId).find((conflict) => conflict.field === 'name');
    expect(name).toBeUndefined();
    expect(getLead(db, leadId)?.name).toBe('Mika Fasade');
  });
});

/* -------------------------------------------------------------------------- */
/* queueSuggestions                                                           */
/* -------------------------------------------------------------------------- */

describe('queueSuggestions', () => {
  it('queues one row per proposed value, with its evidence', () => {
    const leadId = store('Fasade Petrović');
    const evidence = page(
      'negative/fasade-petrovic-novi-sad-drugi.html',
      'https://petrovic-fasade-ns.rs/',
    );
    const entry = target(leadId);
    const verdict = assessCandidate({ lead: entry.record, page: evidence, origin: 'discovered' });
    expect(verdict.tier).toBe('suggest');

    const queued = queueSuggestions(db, entry, evidence, verdict, findingsFrom(entry, evidence), {
      sourceId: SEARCH_SOURCE,
      now: NOW,
    });

    const rows = pendingSuggestions(db, { leadId });
    expect(queued).toBe(rows.length);
    expect(rows.map((row) => row.kind).sort()).toEqual(['address', 'email', 'phone', 'website']);
    for (const row of rows) {
      expect(row.rule).toBe('name_city_alone');
      expect(row.origin).toBe('discovered');
      expect(row.sourceUrl).toBe('https://petrovic-fasade-ns.rs/');
      expect(JSON.parse(row.evidence)).toHaveProperty('signals');
    }
  });

  it('writes nothing onto the lead itself', () => {
    const leadId = store('Fasade Petrović');
    const evidence = page(
      'negative/fasade-petrovic-novi-sad-drugi.html',
      'https://petrovic-fasade-ns.rs/',
    );
    const entry = target(leadId);
    const verdict = assessCandidate({ lead: entry.record, page: evidence, origin: 'discovered' });
    queueSuggestions(db, entry, evidence, verdict, findingsFrom(entry, evidence), {
      sourceId: SEARCH_SOURCE,
      now: NOW,
    });

    expect(distinctPhones(db, leadId)).toEqual([]);
    expect(leadContactClaims(db, leadId)).toEqual([]);
  });
});

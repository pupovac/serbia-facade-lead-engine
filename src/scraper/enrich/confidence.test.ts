/**
 * The confidence gate, and the number this issue exists to produce.
 *
 * The negative corpus below is the point of the file. Every entry in it is a
 * page of a business that is **not** the lead it is being weighed against, and
 * most of them carry a name that a human would have to look twice at. The
 * measured false-merge rate over that corpus is asserted to be exactly zero,
 * because one wrong merge writes a competitor's phone number onto a lead, ships
 * it in the XLSX, and nobody ever notices — the row looks exactly like a good
 * one.
 *
 * Zero **merges** is the criterion, not zero findings. One negative case does
 * reach `suggest`: a genuinely different `Fasade Petrović` in the same city,
 * with nothing else to tell the two apart. That is the correct outcome and the
 * reason the middle band exists — the alternatives are merging it (corruption)
 * or discarding it (which would also discard the real one).
 *
 * The fixtures under `__fixtures__/negative` and `__fixtures__/positive` are
 * authored rather than saved from the web, and that is deliberate: the corpus
 * has to *assert* that two pages are different businesses, and you cannot know
 * that about two pages you found. The real saved pages
 * (`termodom-*`, `tgkomerc-*`) are in `page.test.ts`, where what is under test
 * is the reading rather than the deciding — and `tgkomerc-kontakt.html`, a real
 * page, is used here too, as the positive decisive-identifier case.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { leadRecord, staticQuarantine, type LeadRecord } from '@/lib/dedup';
import { assessCandidate, RULE_TIER } from './confidence.js';
import { readPage } from './page.js';
import { CONFIDENCE_BANDS, OWN_SITE_CONFIDENCE } from './thresholds.js';
import type { EnrichmentOrigin, EnrichmentTier, PageEvidence } from './types.js';

function fixture(name: string, url: string): PageEvidence {
  const html = readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    'utf8',
  );
  return readPage({ url, html, $: cheerio.load(html) });
}

/* -------------------------------------------------------------------------- */
/* The leads under test                                                       */
/* -------------------------------------------------------------------------- */

/** The lead every `Fasade Petrović` page is weighed against. Novi Sad, one phone. */
const PETROVIC_NS: LeadRecord = leadRecord({
  id: 1,
  name: 'Fasade Petrović',
  cityId: 'novi-sad',
  municipalityId: 'novi-sad',
  phones: ['+381641234567'],
});

/** The same business with no city on it — a name can never be placed. */
const PETROVIC_NO_CITY: LeadRecord = leadRecord({ id: 2, name: 'Fasade Petrović' });

const MIKA_NS: LeadRecord = leadRecord({
  id: 3,
  name: 'Mika Fasade',
  cityId: 'novi-sad',
  municipalityId: 'novi-sad',
});

/** The same lead, carrying its own domain: the ownership path. */
const MIKA_OWN_SITE: LeadRecord = leadRecord({
  id: 4,
  name: 'Mika Fasade',
  cityId: 'novi-sad',
  municipalityId: 'novi-sad',
  websiteDomains: ['mikafasade.rs'],
});

/**
 * Novi Sad, carrying the landline that is also on `tgkomerc-98.co.rs` — the
 * decisive-identifier path, against a real saved page.
 */
const TG_BY_PHONE: LeadRecord = leadRecord({
  id: 5,
  name: 'TG Komerc 98',
  cityId: 'novi-sad',
  municipalityId: 'novi-sad',
  phones: ['+381212419400'],
});

/* -------------------------------------------------------------------------- */
/* The negative corpus                                                        */
/* -------------------------------------------------------------------------- */

interface Case {
  readonly label: string;
  readonly lead: LeadRecord;
  readonly page: PageEvidence;
  readonly origin: EnrichmentOrigin;
  readonly tier: EnrichmentTier;
  readonly rule: string;
}

const NEGATIVE: readonly Case[] = [
  {
    label: 'same name, another city — Niš',
    lead: PETROVIC_NS,
    page: fixture('negative/fasade-petrovic-nis.html', 'https://fasade-petrovic-nis.rs/kontakt'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'no_connection',
  },
  {
    label: 'same name in Belgrade, with its own structured address',
    lead: PETROVIC_NS,
    page: fixture('negative/fasade-petrovic-beograd.html', 'https://fasadepetrovic.rs/'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'no_connection',
  },
  {
    label: 'a similar name in the same city — below the name threshold',
    lead: leadRecord({
      id: 9,
      name: 'Termo Fasada Plus',
      cityId: 'beograd',
      municipalityId: 'beograd',
    }),
    page: fixture('negative/termo-fasade-doo.html', 'https://termofasade.rs/'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'no_connection',
  },
  {
    label: 'a directory category page carrying eight businesses',
    lead: MIKA_NS,
    page: fixture('negative/stovariste-listing.html', 'https://neki-portal.rs/stovarista/novi-sad'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'page_is_a_listing',
  },
  {
    label: 'a Facebook page — a platform, not the business’s own site',
    lead: MIKA_NS,
    page: fixture('negative/facebook-page.html', 'https://www.facebook.com/mikafasade'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'origin_is_a_directory',
  },
  {
    label: 'a lead with no city — the name cannot be placed',
    lead: PETROVIC_NO_CITY,
    page: fixture('negative/fasade-petrovic-nis.html', 'https://fasade-petrovic-nis.rs/kontakt'),
    origin: 'discovered',
    tier: 'discard',
    rule: 'lead_has_no_place',
  },
  {
    label: 'the lead’s own site redirected onto a domain it does not own',
    lead: MIKA_OWN_SITE,
    page: fixture('negative/termo-fasade-doo.html', 'https://sedoparking.com/mikafasade.rs'),
    origin: 'own_site',
    tier: 'discard',
    rule: 'no_connection',
  },
  {
    label: 'a different business of the same name in the same city',
    lead: PETROVIC_NS,
    page: fixture('negative/fasade-petrovic-novi-sad-drugi.html', 'https://petrovic-fasade-ns.rs/'),
    origin: 'discovered',
    // The one case in the corpus that is *not* discarded, and must not be:
    // nothing on either side distinguishes the two, so it goes to the queue.
    tier: 'suggest',
    rule: 'name_city_alone',
  },
];

const POSITIVE: readonly Case[] = [
  {
    label: 'a page on the lead’s own domain',
    lead: MIKA_OWN_SITE,
    page: fixture('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
    origin: 'own_site',
    tier: 'merge',
    rule: 'own_site',
  },
  {
    label: 'a discovered page publishing the lead’s landline',
    lead: TG_BY_PHONE,
    page: fixture('tgkomerc-kontakt.html', 'https://tgkomerc-98.co.rs/kontakt/'),
    origin: 'discovered',
    tier: 'merge',
    rule: 'decisive_identifier',
  },
  {
    label: 'a name match in the same city, corroborated by the address',
    lead: leadRecord({
      id: 6,
      name: 'Mika Fasade',
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      // Not byte-identical to what the page's JSON-LD produces — the comma
      // before the town is the difference, and it no longer matters. See the
      // test below.
      addressNormalized: 'Temerinska 12, 21000 Novi Sad',
    }),
    page: fixture('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
    origin: 'discovered',
    tier: 'merge',
    rule: 'name_city_corroborated',
  },
];

/* -------------------------------------------------------------------------- */
/* The acceptance criterion                                                   */
/* -------------------------------------------------------------------------- */

describe('the negative corpus — the false-merge rate', () => {
  it('merges nothing: the measured false-merge rate is zero', () => {
    const merged = NEGATIVE.filter(
      (entry) =>
        assessCandidate({ lead: entry.lead, page: entry.page, origin: entry.origin }).tier ===
        'merge',
    );

    expect(merged.map((entry) => entry.label)).toEqual([]);
    expect(merged.length / NEGATIVE.length).toBe(0);
  });

  it('accounts for every negative case by name, so a silent change is visible', () => {
    const outcomes = NEGATIVE.map((entry) => {
      const verdict = assessCandidate({
        lead: entry.lead,
        page: entry.page,
        origin: entry.origin,
      });
      return [entry.label, verdict.tier, verdict.rule];
    });

    expect(outcomes).toEqual(NEGATIVE.map((entry) => [entry.label, entry.tier, entry.rule]));
  });

  it('sends exactly one of the eight to a human instead of the bin', () => {
    const tiers = NEGATIVE.map(
      (entry) => assessCandidate({ lead: entry.lead, page: entry.page, origin: entry.origin }).tier,
    );
    expect(tiers.filter((tier) => tier === 'discard')).toHaveLength(7);
    expect(tiers.filter((tier) => tier === 'suggest')).toHaveLength(1);
  });
});

describe('the positive corpus', () => {
  it('merges each of the three, by the rule it is supposed to', () => {
    const outcomes = POSITIVE.map((entry) => {
      const verdict = assessCandidate({
        lead: entry.lead,
        page: entry.page,
        origin: entry.origin,
      });
      return [entry.label, verdict.tier, verdict.rule];
    });

    expect(outcomes).toEqual(POSITIVE.map((entry) => [entry.label, entry.tier, entry.rule]));
  });

  it('reports the own-site path at the highest confidence it ever reports, and not at 1', () => {
    const verdict = assessCandidate({
      lead: MIKA_OWN_SITE,
      page: fixture('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
      origin: 'own_site',
    });
    expect(verdict.confidence).toBe(OWN_SITE_CONFIDENCE);
    expect(verdict.confidence).toBeLessThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The rules, one at a time                                                   */
/* -------------------------------------------------------------------------- */

describe('a name match alone never merges', () => {
  it('refuses an identical name in the same city with nothing behind it', () => {
    const verdict = assessCandidate({
      lead: PETROVIC_NS,
      page: fixture(
        'negative/fasade-petrovic-novi-sad-drugi.html',
        'https://petrovic-fasade-ns.rs/',
      ),
      origin: 'discovered',
    });
    expect(verdict.tier).toBe('suggest');
    expect(verdict.rule).toBe('name_city_alone');
    expect(verdict.match.decision).toBe('review');
  });

  it('refuses an identical name in a different city outright', () => {
    const verdict = assessCandidate({
      lead: PETROVIC_NS,
      page: fixture('negative/fasade-petrovic-nis.html', 'https://fasade-petrovic-nis.rs/kontakt'),
      origin: 'discovered',
    });
    expect(verdict.tier).toBe('discard');
    // The two names are identical; the place is what refused it.
    expect(verdict.match.signals.map((signal) => signal.kind)).not.toContain('name_city');
  });
});

describe('ownership', () => {
  it('trusts a page on a domain the lead carries without matching anything', () => {
    // The page's business name is not compared at all on this path — the
    // evidence is that the business publishes the page.
    const lead = leadRecord({
      id: 10,
      name: 'Nešto Sasvim Drugo',
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      websiteDomains: ['mikafasade.rs'],
    });
    const verdict = assessCandidate({
      lead,
      page: fixture('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt'),
      origin: 'own_site',
    });
    expect(verdict.rule).toBe('own_site');
  });

  it('judges ownership on where the response came from, not on what was asked for', () => {
    const page = fixture('negative/termo-fasade-doo.html', 'https://sedoparking.com/mikafasade.rs');
    const verdict = assessCandidate({ lead: MIKA_OWN_SITE, page, origin: 'own_site' });
    expect(verdict.rule).not.toBe('own_site');
    expect(verdict.tier).toBe('discard');
  });

  it('does not let a `www.` prefix or a subdomain break ownership', () => {
    const page = fixture('positive/mika-fasade-kontakt.html', 'https://www.mikafasade.rs/kontakt');
    expect(assessCandidate({ lead: MIKA_OWN_SITE, page, origin: 'own_site' }).rule).toBe(
      'own_site',
    );
  });
});

describe('the listing veto', () => {
  it('runs before ownership, so a listing on the lead’s own domain is still refused', () => {
    const lead = leadRecord({
      id: 11,
      name: 'Mika Fasade',
      cityId: 'novi-sad',
      municipalityId: 'novi-sad',
      websiteDomains: ['neki-portal.rs'],
    });
    const verdict = assessCandidate({
      lead,
      page: fixture(
        'negative/stovariste-listing.html',
        'https://neki-portal.rs/stovarista/novi-sad',
      ),
      origin: 'own_site',
    });
    expect(verdict.rule).toBe('page_is_a_listing');
    expect(verdict.tier).toBe('discard');
  });
});

describe('the quarantine', () => {
  it('demotes a merge to the review queue when the deciding phone is quarantined', () => {
    const verdict = assessCandidate({
      lead: TG_BY_PHONE,
      page: fixture('tgkomerc-kontakt.html', 'https://tgkomerc-98.co.rs/kontakt/'),
      origin: 'discovered',
      quarantine: staticQuarantine([['phone', '+381212419400']]),
    });
    expect(verdict.tier).toBe('suggest');
    expect(verdict.rule).toBe('quarantined_identifier');
  });
});

/* -------------------------------------------------------------------------- */
/* The bands                                                                  */
/* -------------------------------------------------------------------------- */

describe('confidence bands', () => {
  it('never reports a confidence outside the band its rule chose', () => {
    for (const entry of [...NEGATIVE, ...POSITIVE]) {
      const verdict = assessCandidate({
        lead: entry.lead,
        page: entry.page,
        origin: entry.origin,
      });
      const band = CONFIDENCE_BANDS[verdict.tier];
      expect(verdict.confidence).toBeGreaterThanOrEqual(band.min);
      expect(verdict.confidence).toBeLessThanOrEqual(band.max);
    }
  });

  it('does not let the bands overlap, so a confidence names its own outcome', () => {
    expect(CONFIDENCE_BANDS.discard.max).toBeLessThan(CONFIDENCE_BANDS.suggest.min);
    expect(CONFIDENCE_BANDS.suggest.max).toBeLessThan(CONFIDENCE_BANDS.merge.min);
  });

  it('has a tier for every rule and no rule without one', () => {
    const used = new Set(
      [...NEGATIVE, ...POSITIVE].map(
        (entry) =>
          assessCandidate({ lead: entry.lead, page: entry.page, origin: entry.origin }).rule,
      ),
    );
    for (const rule of used) expect(RULE_TIER[rule]).toBeDefined();
    expect(Object.values(RULE_TIER).every((tier) => tier in CONFIDENCE_BANDS)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* A property worth knowing about                                             */
/* -------------------------------------------------------------------------- */

describe('address corroboration survives the way two sources punctuate', () => {
  // FUZZ-21 pinned the old behaviour here rather than working around it:
  // `address_normalized` was `address.toLowerCase()` on both sides, so
  // `Temerinska 12, 21000 Novi Sad` and `Temerinska 12, 21000, Novi Sad` were
  // two addresses to the matcher and the pair stalled one tier short of a
  // merge. FUZZ-31 moved the folding into `src/lib/normalize`; this is the same
  // pair, asserting the outcome it should always have had.
  const page = (): ReturnType<typeof fixture> =>
    fixture('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt');

  const assess = (addressNormalized: string): ReturnType<typeof assessCandidate> =>
    assessCandidate({
      lead: leadRecord({
        id: 12,
        name: 'Mika Fasade',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized,
      }),
      page: page(),
      origin: 'discovered',
    });

  it('corroborates when the two spellings differ by a comma', () => {
    const verdict = assess('Temerinska 12, 21000 Novi Sad');
    expect(verdict.rule).toBe('name_city_corroborated');
    expect(verdict.tier).toBe('merge');
  });

  it.each([
    ['the postal code dropped', 'Temerinska 12, Novi Sad'],
    ['the street marker written out', 'Ul. Temerinska br. 12, 21000 Novi Sad'],
    ['the town in Cyrillic', 'Темеринска 12, Нови Сад'],
    ['the town first', 'Novi Sad, Temerinska 12'],
  ])('corroborates with %s', (_label, addressNormalized) => {
    expect(assess(addressNormalized).rule).toBe('name_city_corroborated');
  });

  it('still refuses to corroborate a different house number', () => {
    const verdict = assess('Temerinska 12a, 21000 Novi Sad');
    expect(verdict.rule).toBe('name_city_alone');
    expect(verdict.tier).toBe('suggest');
  });
});

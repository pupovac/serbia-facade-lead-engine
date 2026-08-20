import { describe, expect, it } from 'vitest';
import { REAL_LINK_SETS } from './fixtures/real-link-sets.js';
import {
  canonicalizeWebsite,
  extractWebsite,
  extractWebsiteWithRejections,
  resolveFinalWebsite,
} from './website.js';
import type { RedirectProbe } from './website.js';

describe('canonicalizeWebsite', () => {
  it('collapses the three forms of the same site to one value', () => {
    const forms = ['HTTP://WWW.Firma.RS/', 'https://firma.rs', 'firma.rs/?utm_source=x'];
    const canonical = forms.map((form) => canonicalizeWebsite(form)?.url);
    expect(canonical).toEqual(['https://firma.rs', 'https://firma.rs', 'https://firma.rs']);
  });

  const canonicalCases: ReadonlyArray<readonly [string, string]> = [
    ['https://www.firma.rs/', 'https://firma.rs'],
    ['https://firma.rs/kontakt/', 'https://firma.rs/kontakt'],
    ['https://firma.rs/#kontakt', 'https://firma.rs'],
    ['https://firma.rs?fbclid=abc&gclid=d', 'https://firma.rs'],
    ['https://firma.rs/proizvodi?id=7&utm_campaign=x', 'https://firma.rs/proizvodi?id=7'],
    ['http:// www.vns.rs', 'https://vns.rs'],
    ['www.fermax.co.rs', 'https://fermax.co.rs'],
    ['https://FIRMA.rs:443/', 'https://firma.rs'],
  ];
  for (const [input, expected] of canonicalCases) {
    it(`canonicalizes ${input}`, () => {
      expect(canonicalizeWebsite(input)?.url).toBe(expected);
    });
  }

  it('is idempotent for every form above', () => {
    for (const [input] of canonicalCases) {
      const once = canonicalizeWebsite(input);
      expect(once).not.toBeNull();
      const twice = canonicalizeWebsite(once?.url ?? '');
      expect(twice?.url).toBe(once?.url);
      expect(twice?.registrableDomain).toBe(once?.registrableDomain);
    }
  });

  it('keeps the scheme the page published, separately from the key', () => {
    const site = canonicalizeWebsite('HTTP://WWW.Firma.RS/');
    expect(site?.observedScheme).toBe('http');
    expect(site?.url).toBe('https://firma.rs');
    expect(site?.raw).toBe('HTTP://WWW.Firma.RS/');
  });

  it('exposes the registrable domain as the dedup key', () => {
    expect(canonicalizeWebsite('https://shop.lensim.co.rs/cenovnik')?.registrableDomain).toBe(
      'lensim.co.rs',
    );
  });

  it('returns null for something that is not a URL', () => {
    expect(canonicalizeWebsite('javascript:void(0)')).toBeNull();
  });
});

describe('rejection rules', () => {
  const sourceDomain = 'www.pttimenik.com';
  const cases: ReadonlyArray<readonly [string, { href: string; text?: string }]> = [
    ['website_unparseable', { href: 'javascript:void(0)' }],
    ['website_source_domain', { href: 'https://mojafirma.navidiku.rs/', text: 'Moja Firma' }],
    ['website_known_directory', { href: 'https://www.011info.com/stovarista' }],
    ['website_social_network', { href: 'https://www.facebook.com/Austrotherm.rs/' }],
    ['website_social_network', { href: 'https://maps.google.com/maps?daddr=Beograd' }],
    ['website_share_intent', { href: 'https://x.com/intent/tweet?url=https%3A%2F%2Fx.rs' }],
    ['website_vendor_credit', { href: 'https://greenfish.rs/', text: 'Web dizajn' }],
    [
      'website_advertising_banner',
      { href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=baner468x60' },
    ],
    ['website_infrastructure', { href: 'https://www.w3.org/WAI/tutorials/images/decision-tree/' }],
    ['website_asset_or_document', { href: 'https://firma.rs/cenovnik-2026.pdf' }],
  ];

  for (const [rule, link] of cases) {
    it(`drops ${link.href} by ${rule}`, () => {
      const { website, rejected } = extractWebsiteWithRejections([link], {
        sourceDomain: rule === 'website_source_domain' ? 'www.navidiku.rs' : sourceDomain,
      });
      expect(website).toBeNull();
      expect(rejected.map((entry) => entry.rule)).toContain(rule);
    });
  }

  it("drops the directory's foreign editions", () => {
    const { website, rejected } = extractWebsiteWithRejections(
      [
        { href: 'https://www.daibau.de', text: 'DE: daibau.de' },
        { href: 'https://www.daibau.at', text: 'AT: daibau.at' },
      ],
      { sourceDomain: 'www.daibau.rs' },
    );
    expect(website).toBeNull();
    expect(rejected.every((entry) => entry.rule === 'website_source_sibling')).toBe(true);
  });

  it('drops every banner to a host that already failed a rule', () => {
    const { website, rejected } = extractWebsiteWithRejections(
      [
        { href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=baner468x60' },
        { href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_campaign=GR_brending' },
      ],
      { sourceDomain: 'www.gradjevinarstvo.rs' },
    );
    expect(website).toBeNull();
    expect(rejected).toHaveLength(2);
  });

  it('records no website when nothing on the page says which link is the site', () => {
    const { website, rejected } = extractWebsiteWithRejections(
      [
        { href: 'http://www.prvitaxi.com' },
        { href: 'http://viladinka.rs' },
        { href: 'http://decorlife.rs/' },
      ],
      { sourceDomain: 'www.biznisgroup.rs' },
    );
    expect(website).toBeNull();
    expect(rejected.map((entry) => entry.rule)).toEqual([
      'website_ambiguous_link_farm',
      'website_ambiguous_link_farm',
      'website_ambiguous_link_farm',
    ]);
  });
});

describe('ranking', () => {
  it('prefers the link labelled as the company site', () => {
    const website = extractWebsite(
      [
        { href: 'https://partner.rs' },
        { href: 'https://vasfasader.rs/', text: 'našem sajtu' },
        { href: 'https://drugi.rs' },
      ],
      { sourceDomain: 'www.navidiku.rs' },
    );
    expect(website?.url).toBe('https://vasfasader.rs');
    expect(website?.evidence).toBe('anchor-text-keyword');
  });

  it('prefers the link whose anchor text is its own domain', () => {
    const website = extractWebsite(
      [
        { href: 'https://www.maximapaints.com/sr/pocetna' },
        { href: 'http://www.ucpartizan.com/', text: 'http://www.ucpartizan.com/' },
      ],
      { sourceDomain: 'www.stovarista.rs' },
    );
    expect(website?.url).toBe('https://ucpartizan.com');
    expect(website?.evidence).toBe('anchor-text-is-domain');
  });

  it('takes a single unlabelled external link as the site', () => {
    const website = extractWebsite([{ href: 'https://www.mida.rs', text: 'MIDA' }], {
      sourceDomain: 'www.nadjimajstora.rs',
    });
    expect(website?.url).toBe('https://mida.rs');
    expect(website?.evidence).toBe('only-external-link');
  });
});

describe('resolveFinalWebsite', () => {
  const site = canonicalizeWebsite('https://bit.ly/3xYz');

  it('follows exactly one hop and records the final host', async () => {
    expect(site?.shortener).toBe(true);
    const probe = async (url: string): Promise<RedirectProbe> =>
      url === 'https://bit.ly/3xYz'
        ? { status: 301, location: 'https://www.fasade-bg.rs/' }
        : { status: 200, location: null };
    const resolved = await resolveFinalWebsite(site as NonNullable<typeof site>, probe);
    expect(resolved.url).toBe('https://fasade-bg.rs');
    expect(resolved.domain).toBe('fasade-bg.rs');
    expect(resolved.raw).toBe('https://bit.ly/3xYz');
  });

  it('resolves a relative Location against the URL', async () => {
    const http = canonicalizeWebsite('http://firma.rs/staro');
    const resolved = await resolveFinalWebsite(http as NonNullable<typeof http>, async () => ({
      status: 302,
      location: '/novo/',
    }));
    expect(resolved.url).toBe('https://firma.rs/novo');
  });

  it('leaves the website alone when there is no redirect', async () => {
    const resolved = await resolveFinalWebsite(site as NonNullable<typeof site>, async () => ({
      status: 200,
      location: null,
    }));
    expect(resolved.url).toBe('https://bit.ly/3xYz');
  });

  it('refuses a hop that lands on a social network', async () => {
    const resolved = await resolveFinalWebsite(site as NonNullable<typeof site>, async () => ({
      status: 301,
      location: 'https://www.facebook.com/fasade.bg',
    }));
    expect(resolved.url).toBe('https://bit.ly/3xYz');
  });
});

describe('real link sets', () => {
  const expected: Record<string, string | null> = {
    '011info-bimax': 'https://bimax.rs',
    'aladin-stovarista': 'https://kodiko.rs',
    'austrotherm-distributeri': null,
    'biznisgroup-gradis': null,
    'daibau-rading': null,
    'gradjevinarstvo-austrotherm': 'https://austrotherm.rs',
    'gradjevinarstvo-popovic': null,
    'gradjevinskefirme-prima': null,
    'majstorimajstori-fasada': null,
    'metalac-stores': null,
    'mirandre-domino': null,
    'nadjimajstora-srdjan': 'https://mida.rs',
    'navidiku-vasfasader': 'https://vasfasader.rs',
    'portal-srbija-stovarista-bg': 'https://ostrog.rs',
    'poslovnikontakt-dragomir': null,
    'pttimenik-hemoluks': 'https://hemoluks.com',
    'stovarista-ucpartizan': 'https://ucpartizan.com',
    'superprostor-kalcer': null,
    'zutestrane-fermax': 'https://fermax.co.rs',
  };

  it('covers every captured page', () => {
    expect(REAL_LINK_SETS).toHaveLength(19);
    expect(Object.keys(expected).sort()).toEqual(REAL_LINK_SETS.map((set) => set.id).sort());
  });

  for (const set of REAL_LINK_SETS) {
    it(`${set.id}: ${expected[set.id] ?? 'no website'}`, () => {
      const website = extractWebsite(set.links, { sourceDomain: set.sourceDomain });
      expect(website?.url ?? null).toBe(expected[set.id] ?? null);
    });
  }

  it('never returns the source itself as a website', () => {
    for (const set of REAL_LINK_SETS) {
      const website = extractWebsite(set.links, { sourceDomain: set.sourceDomain });
      if (website === null) continue;
      expect(website.domain).not.toBe(set.sourceDomain.replace(/^www\./, ''));
    }
  });
});

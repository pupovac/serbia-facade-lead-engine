import { describe, expect, it } from 'vitest';
import { REAL_LINK_SETS } from './fixtures/real-link-sets.js';
import { extractSocials, extractSocialsWithRejections } from './social.js';

describe('facebook', () => {
  const sameProfile = [
    'https://www.facebook.com/fasade.bg',
    'https://facebook.com/fasade.bg/',
    'https://m.facebook.com/fasade.bg',
    'https://web.facebook.com/fasade.bg?ref=page_internal',
    'https://www.facebook.com/fasade.bg/about/?ref=page_internal',
    'https://www.facebook.com/fasade.bg/posts/1234567890',
    'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.facebook.com%2Ffasade.bg&h=AT1',
    'https://fb.com/Fasade.BG',
  ];

  for (const url of sameProfile) {
    it(`reads the page slug out of ${url}`, () => {
      const { facebook } = extractSocials([url]);
      expect(facebook?.id).toBe('fasade.bg');
      expect(facebook?.idKind).toBe('slug');
      expect(facebook?.url).toBe('https://www.facebook.com/fasade.bg');
    });
  }

  it('reads the page id out of a /pages/ URL, malformed href and all', () => {
    // poslovnikontakt.com prints this href without closing the attribute.
    const { facebook } = extractSocials([
      'https://www.facebook.com/pages/Agencija-Poslovni-kontakt/984748621542308?ref=hl/  target="_blank"',
    ]);
    expect(facebook?.id).toBe('984748621542308');
    expect(facebook?.idKind).toBe('numeric_id');
  });

  it('reads profile.php?id=', () => {
    const { facebook } = extractSocials([
      'https://www.facebook.com/profile.php?id=100063567891234',
    ]);
    expect(facebook?.id).toBe('100063567891234');
    expect(facebook?.url).toBe('https://www.facebook.com/profile.php?id=100063567891234');
  });

  const notProfiles: ReadonlyArray<readonly [string, string]> = [
    ['social_share_intent', 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fx.rs'],
    ['social_share_intent', 'https://www.facebook.com/share.php?u=https://x.rs'],
    ['social_platform_root', 'https://www.facebook.com/'],
    ['social_not_a_profile', 'https://www.facebook.com/groups/fasaderi'],
    ['social_not_a_profile', 'https://www.facebook.com/hashtag/fasada'],
    ['social_not_a_profile', 'https://www.facebook.com/permalink.php?story_fbid=1&id=2'],
    ['social_not_a_profile', 'https://www.facebook.com/watch/?v=123'],
  ];
  for (const [rule, url] of notProfiles) {
    it(`drops ${url}`, () => {
      const { socials, rejected } = extractSocialsWithRejections([url]);
      expect(socials.facebook).toBeUndefined();
      expect(rejected[0]?.rule).toBe(rule);
    });
  }
});

describe('instagram', () => {
  const sameProfile = [
    'https://www.instagram.com/fasade_bg/',
    'https://instagram.com/fasade_bg',
    'https://www.instagram.com/fasade_bg/?hl=sr',
    'https://m.instagram.com/fasade_bg',
    'https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Ffasade_bg%2F&e=AT0',
    'https://www.instagram.com/stories/fasade_bg/3212345678901234567/',
  ];
  for (const url of sameProfile) {
    it(`reads the handle out of ${url}`, () => {
      const { instagram } = extractSocials([url]);
      expect(instagram?.id).toBe('fasade_bg');
      expect(instagram?.idKind).toBe('handle');
      expect(instagram?.url).toBe('https://www.instagram.com/fasade_bg');
    });
  }

  const notProfiles = [
    'https://www.instagram.com/p/CxYz12AbCdE/',
    'https://www.instagram.com/reel/CxYz12AbCdE/',
    'https://www.instagram.com/explore/tags/fasada/',
    'https://www.instagram.com/accounts/login/',
  ];
  for (const url of notProfiles) {
    it(`drops ${url}`, () => {
      const { socials, rejected } = extractSocialsWithRejections([url]);
      expect(socials.instagram).toBeUndefined();
      expect(rejected[0]?.rule).toBe('social_not_a_profile');
    });
  }
});

describe('google maps', () => {
  it('reads the feature id out of a /maps/place/ URL', () => {
    // market.metalac.com links its Gornji Milanovac store this way.
    const { googleMaps } = extractSocials([
      'https://www.google.com/maps/place/Kneza+Aleksandra+212,+Gornji+Milanovac+32300/@44.0378172,20.4781858,17z/data=!3m1!4b1!4m5!3m4!1s0x475741d73a50b41f:0xf0bc77c82a052c67!8m2!3d44.0378172!4d20.4803746',
    ]);
    expect(googleMaps?.idKind).toBe('ftid');
    expect(googleMaps?.id).toBe('0x475741d73a50b41f:0xf0bc77c82a052c67');
  });

  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['cid', 'https://maps.google.com/?cid=8834321234567890123', '8834321234567890123'],
    [
      'place_id',
      'https://www.google.com/maps/search/?api=1&query=Fasade&query_place_id=ChIJm2fasade123',
      'ChIJm2fasade123',
    ],
    ['place_id', 'https://www.google.com/maps?q=place_id:ChIJm2fasade123', 'ChIJm2fasade123'],
    ['short_link', 'https://maps.app.goo.gl/aBcD1234', 'aBcD1234'],
    // 011info prints a navigation link that still pins the business.
    [
      'coordinates',
      'https://www.google.com/maps/dir/?api=1&destination=44.848134,20.394314&travelmode=driving&lang=sr',
      '44.848134,20.394314',
    ],
    [
      'coordinates',
      'https://maps.google.com?daddr=43.148506,20.52075960000002',
      '43.148506,20.520760',
    ],
  ];
  for (const [idKind, url, id] of cases) {
    it(`reads the ${idKind} out of ${url.slice(0, 60)}…`, () => {
      const { googleMaps } = extractSocials([url]);
      expect(googleMaps?.idKind).toBe(idKind);
      expect(googleMaps?.id).toBe(id);
    });
  }

  it('drops a directions link to a typed address, which pins nothing', () => {
    // majstorimajstori.com sends you to the city, not to the business.
    const { socials, rejected } = extractSocialsWithRejections([
      'https://maps.google.com/maps?daddr=Beograd%2C+Beograd%2C+38',
    ]);
    expect(socials.googleMaps).toBeUndefined();
    expect(rejected[0]?.rule).toBe('social_no_stable_identifier');
  });
});

describe("the directory's own profiles", () => {
  it('drops the profile whose name is the source brand', () => {
    const { socials, rejected } = extractSocialsWithRejections(
      [
        'https://www.facebook.com/Navidiku.rs',
        'https://www.instagram.com/navidiku.rs/',
        'https://www.facebook.com/vas.fasader',
      ],
      { sourceDomain: 'www.navidiku.rs' },
    );
    expect(socials.facebook?.id).toBe('vas.fasader');
    expect(socials.instagram).toBeUndefined();
    expect(rejected.map((entry) => entry.rule)).toEqual([
      'social_directory_profile',
      'social_directory_profile',
    ]);
  });

  it('drops a profile the source declares as its own when the brand does not match', () => {
    const { socials, rejected } = extractSocialsWithRejections(
      ['https://www.facebook.com/pages/Agencija-Poslovni-kontakt/984748621542308'],
      { sourceDomain: 'poslovnikontakt.com', sourceOwnedProfiles: ['984748621542308'] },
    );
    expect(socials.facebook).toBeUndefined();
    expect(rejected[0]?.rule).toBe('social_directory_profile');
  });

  it('keeps a business profile that merely mentions the source city', () => {
    const { facebook } = extractSocials(['https://www.facebook.com/fasade.beograd'], {
      sourceDomain: 'www.011info.com',
    });
    expect(facebook?.id).toBe('fasade.beograd');
  });
});

describe('real link sets', () => {
  const expected: Record<string, { facebook?: string; instagram?: string; googleMaps?: string }> = {
    '011info-bimax': { googleMaps: '44.848134,20.394314' },
    'aladin-stovarista': {},
    'austrotherm-distributeri': {},
    'biznisgroup-gradis': { instagram: 'biznis_katalog_evrope', googleMaps: '43.148506,20.520760' },
    'daibau-rading': {},
    'gradjevinarstvo-austrotherm': {},
    'gradjevinarstvo-popovic': {},
    'gradjevinskefirme-prima': {},
    'majstorimajstori-fasada': {},
    'metalac-stores': { googleMaps: '0x475741d73a50b41f:0xf0bc77c82a052c67' },
    'mirandre-domino': {},
    'nadjimajstora-srdjan': {},
    'navidiku-vasfasader': { googleMaps: '44.813012,20.469786' },
    'portal-srbija-stovarista-bg': {},
    'poslovnikontakt-dragomir': {
      facebook: '984748621542308',
      instagram: 'apartmani_zlatibor_smestaj',
    },
    'pttimenik-hemoluks': {},
    'stovarista-ucpartizan': {},
    'superprostor-kalcer': {},
    'zutestrane-fermax': {},
  };

  for (const set of REAL_LINK_SETS) {
    it(`${set.id}`, () => {
      const socials = extractSocials(set.links, { sourceDomain: set.sourceDomain });
      expect({
        ...(socials.facebook === undefined ? {} : { facebook: socials.facebook.id }),
        ...(socials.instagram === undefined ? {} : { instagram: socials.instagram.id }),
        ...(socials.googleMaps === undefined ? {} : { googleMaps: socials.googleMaps.id }),
      }).toEqual(expected[set.id]);
    });
  }

  it('never returns a share widget as a profile', () => {
    for (const set of REAL_LINK_SETS) {
      const { socials } = extractSocialsWithRejections(set.links, {
        sourceDomain: set.sourceDomain,
      });
      for (const profile of [socials.facebook, socials.instagram, socials.googleMaps]) {
        expect(profile?.raw ?? '').not.toMatch(/sharer|share\.php|intent/);
      }
    }
  });
});

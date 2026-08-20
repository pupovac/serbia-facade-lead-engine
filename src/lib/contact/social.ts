/**
 * Facebook, Instagram and Google Maps extraction.
 *
 * The same profile appears with a dozen decorations — `m.facebook.com`,
 * `l.instagram.com/?u=`, `?ref=page_internal`, `?hl=sr`, a post path under the
 * page slug — so what is stored is the stable identifier, never the URL as
 * found. Every Serbian listing page also links its OWN Facebook and Instagram
 * in the footer, which is why `sourceDomain` matters: without it every lead
 * from navidiku.rs would carry navidiku.rs's Facebook page.
 */
import { brandLabel, normalizeHost, parseLooseUrl, registrableDomain } from './url.js';
import type {
  ExtractedSocials,
  LinkCandidate,
  LinkInput,
  Rejection,
  SocialOptions,
  SocialProfile,
  SocialRejectionRuleId,
} from './types.js';

/** Facebook paths that are a feature, not a page. */
const FACEBOOK_RESERVED: ReadonlySet<string> = new Set([
  'sharer',
  'sharer.php',
  'share.php',
  'share',
  'dialog',
  'plugins',
  'tr',
  'login.php',
  'login',
  'recover',
  'help',
  'policies',
  'policy.php',
  'legal',
  'privacy',
  'terms',
  'settings',
  'search',
  'hashtag',
  'events',
  'event.php',
  'groups',
  'group.php',
  'watch',
  'marketplace',
  'gaming',
  'photo',
  'photo.php',
  'permalink.php',
  'story.php',
  'notes',
  'media',
  'ads',
  'business',
  'messages',
  'home.php',
  'reel',
  'video.php',
]);

const INSTAGRAM_RESERVED: ReadonlySet<string> = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'privacy',
  'terms',
  'challenge',
  'emails',
  'session',
  'graphql',
  'web',
]);

const FACEBOOK_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|facebook\.net)$/i;
const INSTAGRAM_HOSTS = /(^|\.)instagram\.com$/i;
const GOOGLE_MAPS_HOSTS = /(^|\.)(google\.[a-z.]{2,7}|goo\.gl|g\.page|maps\.app\.goo\.gl)$/i;

const HANDLE = /^[a-z0-9._]{1,30}$/;
const PAGE_SLUG = /^[a-z0-9.\-_]{2,60}$/i;
const NUMERIC = /^[0-9]{5,}$/;
/** `!1s0x475b...:0x8e...` — the feature id Google Maps hides in the `data` parameter. */
const FTID = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;
const COORDINATES = /^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

interface Rejected {
  readonly rule: SocialRejectionRuleId;
  readonly detail?: string;
}

type Parsed = SocialProfile | Rejected;

function isProfile(value: Parsed): value is SocialProfile {
  return 'network' in value;
}

function segments(url: URL): string[] {
  return url.pathname.split('/').filter((part) => part !== '');
}

/** `l.facebook.com/l.php?u=…` and `l.instagram.com/?u=…` wrap the real link. */
function unwrapRedirect(url: URL): URL {
  const host = normalizeHost(url.hostname);
  if (!/^(l|lm|away)\./.test(host) && host !== 'l.facebook.com') return url;
  const target = url.searchParams.get('u') ?? url.searchParams.get('url');
  if (target === null) return url;
  const inner = parseLooseUrl(target);
  return inner ?? url;
}

function facebook(url: URL, raw: string): Parsed {
  const parts = segments(url);
  const first = parts[0];
  if (first === undefined) return { rule: 'social_platform_root' };
  const key = first.toLowerCase();
  if (key === 'sharer.php' || key === 'share.php' || key === 'sharer' || key === 'share') {
    return { rule: 'social_share_intent' };
  }
  if (key === 'profile.php') {
    const id = url.searchParams.get('id');
    if (id !== null && NUMERIC.test(id)) {
      return {
        network: 'facebook',
        id,
        idKind: 'numeric_id',
        url: `https://www.facebook.com/profile.php?id=${id}`,
        raw,
      };
    }
    return { rule: 'social_no_stable_identifier' };
  }
  // `/pages/Naziv-Firme/984748621542308` and `/people/Ime/1234` end in the page id.
  if (key === 'pages' || key === 'people' || key === 'p') {
    const numeric = parts.find((part) => NUMERIC.test(part));
    if (numeric !== undefined) {
      return {
        network: 'facebook',
        id: numeric,
        idKind: 'numeric_id',
        url: `https://www.facebook.com/${numeric}`,
        raw,
      };
    }
    return { rule: 'social_no_stable_identifier' };
  }
  if (FACEBOOK_RESERVED.has(key)) return { rule: 'social_not_a_profile', detail: key };
  if (!PAGE_SLUG.test(first)) return { rule: 'social_not_a_profile', detail: first };
  const slug = first.toLowerCase();
  return {
    network: 'facebook',
    id: slug,
    idKind: 'slug',
    url: `https://www.facebook.com/${slug}`,
    raw,
  };
}

function instagram(url: URL, raw: string): Parsed {
  const parts = segments(url);
  const first = parts[0];
  if (first === undefined) return { rule: 'social_platform_root' };
  const key = first.toLowerCase();
  // `/stories/handle/123…` still names the account.
  if (key === 'stories') {
    const handle = parts[1]?.toLowerCase();
    if (handle !== undefined && HANDLE.test(handle)) {
      return {
        network: 'instagram',
        id: handle,
        idKind: 'handle',
        url: `https://www.instagram.com/${handle}`,
        raw,
      };
    }
    return { rule: 'social_not_a_profile', detail: key };
  }
  if (INSTAGRAM_RESERVED.has(key)) return { rule: 'social_not_a_profile', detail: key };
  if (!HANDLE.test(key)) return { rule: 'social_not_a_profile', detail: first };
  return {
    network: 'instagram',
    id: key,
    idKind: 'handle',
    url: `https://www.instagram.com/${key}`,
    raw,
  };
}

function coordinateId(value: string): string | null {
  const normalized = value.replace(/\s+/g, '');
  if (!COORDINATES.test(normalized)) return null;
  const [lat, lng] = normalized.split(',');
  if (lat === undefined || lng === undefined) return null;
  return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

function googleMaps(url: URL, raw: string): Parsed {
  const host = normalizeHost(url.hostname);
  const parts = segments(url);
  const path = url.pathname.toLowerCase();

  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.page') {
    const code = parts[parts.length - 1];
    if (code !== undefined && code !== 'maps' && code !== '') {
      return {
        network: 'googleMaps',
        id: code,
        idKind: 'short_link',
        url: `https://${host}/${parts.join('/')}`,
        raw,
      };
    }
    return { rule: 'social_no_stable_identifier' };
  }

  const placeId = url.searchParams.get('place_id') ?? url.searchParams.get('query_place_id');
  if (placeId !== null && placeId !== '') {
    return {
      network: 'googleMaps',
      id: placeId,
      idKind: 'place_id',
      url: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
      raw,
    };
  }
  const query = url.searchParams.get('q') ?? '';
  const queryPlaceId = /^place_id:(.+)$/.exec(query)?.[1];
  if (queryPlaceId !== undefined && queryPlaceId !== '') {
    return {
      network: 'googleMaps',
      id: queryPlaceId,
      idKind: 'place_id',
      url: `https://www.google.com/maps/place/?q=place_id:${queryPlaceId}`,
      raw,
    };
  }
  const cid = url.searchParams.get('cid');
  if (cid !== null && /^\d+$/.test(cid)) {
    return {
      network: 'googleMaps',
      id: cid,
      idKind: 'cid',
      url: `https://maps.google.com/?cid=${cid}`,
      raw,
    };
  }
  const ftid =
    url.searchParams.get('ftid') ?? FTID.exec(url.searchParams.get('data') ?? url.href)?.[1];
  if (ftid !== undefined && ftid !== null && ftid !== '') {
    return {
      network: 'googleMaps',
      id: ftid.toLowerCase(),
      idKind: 'ftid',
      url: `https://www.google.com/maps/place/?ftid=${ftid.toLowerCase()}`,
      raw,
    };
  }

  // A directions link still pins the business when the destination is a coordinate pair.
  for (const key of ['destination', 'daddr', 'q', 'll', 'center']) {
    const id = coordinateId(url.searchParams.get(key) ?? '');
    if (id !== null) {
      return {
        network: 'googleMaps',
        id,
        idKind: 'coordinates',
        url: `https://www.google.com/maps/search/?api=1&query=${id}`,
        raw,
      };
    }
  }
  const atMatch = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/.exec(url.pathname);
  if (atMatch !== null && path.includes('/place/')) {
    const id = coordinateId(`${atMatch[1]},${atMatch[2]}`);
    if (id !== null) {
      return {
        network: 'googleMaps',
        id,
        idKind: 'coordinates',
        url: `https://www.google.com/maps/search/?api=1&query=${id}`,
        raw,
      };
    }
  }
  if (!path.startsWith('/maps') && !host.startsWith('maps.'))
    return { rule: 'social_not_a_profile' };
  return { rule: 'social_no_stable_identifier' };
}

function ownedBySource(profile: SocialProfile, opts: SocialOptions): boolean {
  const explicit = (opts.sourceOwnedProfiles ?? []).map((value) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
  const id = profile.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (explicit.includes(id) || explicit.some((value) => value.includes(id) && id.length >= 4)) {
    return true;
  }
  const source = opts.sourceDomain;
  if (source === undefined || source === '') return false;
  const brand = brandLabel(source).replace(/[^a-z0-9]/g, '');
  if (brand.length < 4 || id.length < 4) return false;
  return id.includes(brand) || brand.includes(id);
}

/**
 * The Facebook page, Instagram profile and Google Maps place in a link set,
 * each reduced to its stable identifier, plus everything that was dropped.
 *
 * The first usable link per network wins; later ones are ignored rather than
 * rejected, because a page legitimately links its own profile more than once.
 */
export function extractSocialsWithRejections(
  links: readonly LinkInput[],
  opts: SocialOptions = {},
): { socials: ExtractedSocials; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  let facebookProfile: SocialProfile | undefined;
  let instagramProfile: SocialProfile | undefined;
  let mapsProfile: SocialProfile | undefined;

  for (const link of links) {
    const candidate: LinkCandidate = typeof link === 'string' ? { href: link } : link;
    const parsedUrl = parseLooseUrl(candidate.href);
    if (parsedUrl === null) continue;
    const url = unwrapRedirect(parsedUrl);
    const host = normalizeHost(url.hostname);
    const registrable = registrableDomain(host);

    let parsed: Parsed | null = null;
    if (FACEBOOK_HOSTS.test(host)) parsed = facebook(url, candidate.href);
    else if (INSTAGRAM_HOSTS.test(host)) parsed = instagram(url, candidate.href);
    else if (
      GOOGLE_MAPS_HOSTS.test(host) &&
      (url.pathname.startsWith('/maps') ||
        host.startsWith('maps.') ||
        registrable === 'goo.gl' ||
        registrable === 'g.page')
    ) {
      parsed = googleMaps(url, candidate.href);
    }
    if (parsed === null) continue;

    if (!isProfile(parsed)) {
      rejected.push(
        parsed.detail === undefined
          ? { value: candidate.href, rule: parsed.rule }
          : { value: candidate.href, rule: parsed.rule, detail: parsed.detail },
      );
      continue;
    }
    if (ownedBySource(parsed, opts)) {
      rejected.push({ value: candidate.href, rule: 'social_directory_profile', detail: parsed.id });
      continue;
    }
    if (parsed.network === 'facebook' && facebookProfile === undefined) facebookProfile = parsed;
    else if (parsed.network === 'instagram' && instagramProfile === undefined)
      instagramProfile = parsed;
    else if (parsed.network === 'googleMaps' && mapsProfile === undefined) mapsProfile = parsed;
  }

  const socials: ExtractedSocials = {
    ...(facebookProfile === undefined ? {} : { facebook: facebookProfile }),
    ...(instagramProfile === undefined ? {} : { instagram: instagramProfile }),
    ...(mapsProfile === undefined ? {} : { googleMaps: mapsProfile }),
  };
  return { socials, rejected };
}

/** The Facebook page, Instagram profile and Google Maps place in a link set. */
export function extractSocials(
  links: readonly LinkInput[],
  opts: SocialOptions = {},
): ExtractedSocials {
  return extractSocialsWithRejections(links, opts).socials;
}

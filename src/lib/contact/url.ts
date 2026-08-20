/**
 * URL plumbing shared by the contact extractors.
 *
 * Scraped hrefs are not URLs — they are whatever a PHP template printed in
 * 2013. Every helper here is written against forms this project actually met
 * on Serbian listing pages: `http:// www.vns.rs` (a space inside the URL),
 * `...?ref=hl/  target="_blank"` (the closing quote missing), schemeless
 * `www.fermax.co.rs` printed as plain text, and hosts that only differ by
 * `www.`, casing or a tracking parameter.
 */

/**
 * Multi-label public suffixes this dataset actually meets. `co.rs`, `in.rs`
 * and friends are RNIDS second levels; the foreign ones show up because the
 * directories run country editions (`daibau.co.uk`, `austrotherm.com.tr`).
 *
 * This is deliberately a short table and not the full Public Suffix List: the
 * registrable domain is a deduplication key, so a wrong answer merges two
 * businesses. A suffix that is missing here degrades to "one label less",
 * which splits a lead rather than merging two — the safe direction.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.rs',
  'org.rs',
  'edu.rs',
  'ac.rs',
  'gov.rs',
  'in.rs',
  'co.uk',
  'org.uk',
  'me.uk',
  'com.tr',
  'com.hr',
  'com.ba',
  'com.mk',
  'com.au',
  'co.at',
  'or.at',
  'com.de',
  'co.nz',
  'com.br',
]);

/** Query parameters that carry campaign or session state, never identity. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'ttclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'source',
  '_ga',
  '_gl',
  'sthash',
  'hl',
  'lang',
]);

/** Advertising markers: an `utm_medium` like `baner468x60` is a paid banner, not a business link. */
const AD_MEDIUM = /ban+er|banner|display|cpc|ppc|popup/i;

const HTML_AMP = /&amp;/gi;
const WHITESPACE = /\s+/;

/**
 * Turn a scraped href into a `URL`, repairing the damage listing pages do.
 *
 * - `&amp;` is decoded — raw HTML reaches us un-decoded often enough.
 * - `http:// www.vns.rs` (portal-srbija) has the space after the scheme removed.
 * - `...?ref=hl/  target="_blank"` (poslovnikontakt) is cut at the whitespace,
 *   then at a stray quote.
 * - A schemeless `www.fermax.co.rs` or `firma.rs/kontakt` gets `https://`,
 *   because zutestrane prints the site as text rather than as a link.
 *
 * Returns `null` for anything that is not an absolute http(s) URL after that —
 * `#`, `tel:`, `javascript:`, `/kontakt`, and empty strings included.
 */
export function parseLooseUrl(raw: string): URL | null {
  let value = raw.replace(HTML_AMP, '&').trim();
  if (value === '') return null;

  if (WHITESPACE.test(value)) {
    const rejoined = value.replace(/^(https?:)\/\/\s+/i, '$1//');
    const [head] = rejoined.split(WHITESPACE);
    value = head ?? '';
  }
  const quote = value.search(/["'<>]/);
  if (quote >= 0) value = value.slice(0, quote);
  if (value === '') return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
  } else {
    if (value.startsWith('//')) value = `https:${value}`;
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(value)) value = `https://${value}`;
    else return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;
  return url;
}

/** Lower-case the host and drop a leading `www.`. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/**
 * The registrable domain — `stovariste-nuto.com`, `gipsart.co.rs`,
 * `cu.rs` for `gradjevinskefirme.cu.rs`. This is the top-tier deduplication
 * key after the phone number, so it is computed in exactly one place.
 */
export function registrableDomain(host: string): string {
  const labels = normalizeHost(host).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** The brand label of a host: `navidiku` for `www.navidiku.rs`, `daibau` for `daibau.co.uk`. */
export function brandLabel(host: string): string {
  const registrable = registrableDomain(host);
  return registrable.split('.')[0] ?? '';
}

/** True when `host` is the same site as `other`, or a subdomain of it. */
export function isSameSite(host: string, other: string): boolean {
  const a = normalizeHost(host);
  const b = normalizeHost(other);
  if (a === b) return true;
  return registrableDomain(a) === registrableDomain(b) && registrableDomain(a) !== '';
}

/** True when the URL is decorated with paid-banner campaign parameters. */
export function looksLikeAdLink(url: URL): boolean {
  const medium = url.searchParams.get('utm_medium');
  const campaign = url.searchParams.get('utm_campaign');
  return AD_MEDIUM.test(medium ?? '') || AD_MEDIUM.test(campaign ?? '');
}

/**
 * The canonical string form of a URL: `https` scheme, `www`-less lower-case
 * host, no default port, no tracking parameters, remaining query sorted, no
 * trailing slash, no fragment. A non-default port is kept — it is part of the
 * address, unlike the scheme.
 *
 * The scheme is forced to `https` on purpose. `HTTP://WWW.Firma.RS/` and
 * `https://firma.rs` are the same business and must produce the same key; the
 * scheme a directory happened to print is not identity. The observed scheme is
 * kept separately by the caller when it matters.
 */
export function canonicalUrlString(url: URL): string {
  const host = normalizeHost(url.hostname);
  const params = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAMS.has(key.toLowerCase()),
  );
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  const port = url.port === '' || url.port === '80' || url.port === '443' ? '' : `:${url.port}`;
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '/') path = '';
  return `https://${host}${port}${path}${query === '' ? '' : `?${query}`}`;
}

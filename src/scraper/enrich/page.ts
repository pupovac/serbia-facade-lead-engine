/**
 * One fetched HTML page → `PageEvidence`.
 *
 * Pure, and the only place that knows what a contact page looks like. Every
 * value it produces comes out of `src/lib` — `extractPhones`, `extractEmails`,
 * `extractSocials`, `canonicalizeWebsite`, `resolveCityDetailed` — because a
 * second phone regex or a second email de-obfuscator inside the enrichment
 * crawler is exactly the drift the `src/lib` boundary exists to prevent.
 *
 * ## Two extractor options are deliberately not what an adapter passes
 *
 * `extractEmails` and `extractSocials` both take a `sourceDomain` so a
 * directory's own gmail account and its own Facebook page are dropped from
 * every listing it publishes. Here the page is believed to belong to the
 * business, so "the source's own address" and "the business's address" are the
 * *same address* — passing the host would reject `info@firma.rs` on firma.rs
 * and `facebook.com/firma` linked from firma.rs, which is precisely what
 * enrichment exists to collect. A directory is kept out one step later and
 * completely, by the `origin_is_a_directory` veto in `confidence.ts`.
 *
 * ## Two grades of address, and only one of them may corroborate
 *
 * schema.org `PostalAddress`, in JSON-LD or microdata, is a machine-readable
 * statement by the site owner. A line the page labelled `Adresa: Klisanski put
 * 167, 21000 Novi Sad` is the business saying the same thing in prose, and it
 * is far more common on the Serbian web than the markup is — refusing to read
 * it would throw away most of the addresses this crawler exists to find.
 *
 * They are not equally safe, because an address feeds `scoreMatch` as
 * *corroboration*: it is what promotes a name match to a merge, so a wrong one
 * merges two businesses. So the two grades are separated at the point where it
 * matters. A **structured** address goes into `candidateRecord` and can
 * corroborate. A **labelled** one is attached to the lead and resolves the
 * city, but never reaches the matcher's `addressNormalized`, so the worst it
 * can do on its own is move a page from `discard` to `suggest` — a queue entry
 * a human reads, not a value written onto a lead.
 *
 * Nothing is read from unlabelled prose at all.
 */
import type { CheerioAPI } from 'cheerio';
import {
  canonicalizeWebsite,
  extractEmails,
  extractSocials,
  registrableDomain,
  toContactInputs,
} from '@/lib/contact';
import { leadRecord } from '@/lib/dedup';
import { normalizeAddress, resolveCityDetailed } from '@/lib/normalize';
import { extractPhones, toPhoneInput, normalizePhone } from '@/lib/phone';
import { normalizeWhitespace } from '@/lib/text/fold.js';
import type { ExtractedSocials } from '@/lib/contact';
import type { EvidencePhone, EvidenceSocial, PageEvidence } from './types.js';

/** schema.org types that mean "this node is a business". */
const BUSINESS_TYPE = /Organization|LocalBusiness|Store|Corporation|ProfessionalService|Business/i;

/**
 * Trailing page labels a site puts after its name in `<title>`.
 *
 * `Fasade Petrović | Kontakt` is the business plus a page label, and the label
 * must not end up in the name the matcher compares.
 */
const TITLE_PAGE_LABEL =
  /^(kontakt|kontakti|contact|contact us|o nama|onama|about|about us|home|naslovna|po[čc]etna|impressum|usluge|services)$/i;

const TITLE_SEPARATOR = /\s*[|–—·•]\s*|\s+[-/]\s+/;

export interface ReadPageOptions {
  /** The URL asked for. */
  readonly url: string;
  /** Where the response came from after redirects. Provenance is written from this. */
  readonly finalUrl?: string | undefined;
  /** The raw HTML, needed as text for `extractPhones({ html: true })`. */
  readonly html: string;
  readonly $: CheerioAPI;
}

/**
 * Read everything one page claims about a business.
 *
 * Nothing here decides whose claims they are; that is `assessCandidate`.
 */
export function readPage(options: ReadPageOptions): PageEvidence {
  const { $, html } = options;
  const finalUrl = options.finalUrl ?? options.url;
  const jsonLd = jsonLdNodes($);
  const businesses = jsonLd.filter(isBusinessNode);

  const phones = readPhones(html);
  const text = textOf(html, $);
  const extractedEmails = extractEmails(text, { sourceDomain: '', links: hrefs($) });
  const emails = extractedEmails.map((email) => email.email);
  const extractedSocials = extractSocials(
    hrefs($).map((href) => ({ href })),
    {},
  );
  const socials = readSocials(extractedSocials);
  const website = siteOf(finalUrl);
  const address = readAddress($, businesses, text);
  const businessName = readName($, businesses);

  const place = address.locality ?? address.full;
  const resolution = place === null ? null : resolveCityDetailed(place, phoneHint(phones));
  const city = resolution !== null && resolution.ok ? resolution.match : null;

  const record = leadRecord({
    name: businessName ?? '',
    cityId: city?.cityId ?? null,
    municipalityId: city?.municipalityId ?? null,
    // Structured only. A labelled address may place the business, but it may
    // not be the corroboration that promotes a name match to a merge.
    addressNormalized:
      address.grade === 'structured' && address.full !== null
        ? normalizeAddress(address.full).ascii
        : null,
    phones: phones.map((phone) => phone.e164),
    websiteDomains: website === null ? [] : [website.registrableDomain],
    emails,
    socialUrls: socials.map((social) => social.url),
  });

  return {
    url: options.url,
    finalUrl,
    businessName,
    phones,
    emails,
    website: website?.url ?? null,
    websiteDomain: website?.domain ?? null,
    socials,
    address: address.full,
    addressGrade: address.grade,
    postalCode: address.postalCode,
    cityRaw: place,
    cityId: city?.cityId ?? null,
    municipalityId: city?.municipalityId ?? null,
    businessesOnPage: countBusinesses($, businesses),
    // Already through `src/lib/contact`'s boundary translator. `apply.ts`
    // filters these by what the lead is missing rather than re-extracting: a
    // second pass with the page's own host as `sourceDomain` would reject
    // `info@mikafasade.rs` on mikafasade.rs as a directory-owned address.
    contacts: toContactInputs({
      emails: extractedEmails,
      website: website === null ? null : website.normalized,
      socials: extractedSocials,
    }),
    candidateRecord: record,
  };
}

/* -------------------------------------------------------------------------- */
/* Phones, socials, website                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every parseable number on the page, structured origins first.
 *
 * Unlike an adapter's `phones: []` claim, nothing here is a *source saying*
 * "this is the number" — it is all read off a page — so a candidate that
 * `libphonenumber-js` rejects is dropped rather than stored with `valid:
 * false`. An unparseable string on a lead is evidence about what a directory
 * published; on an enriched lead it is a guess with no one behind it.
 */
function readPhones(html: string): EvidencePhone[] {
  const found: EvidencePhone[] = [];
  const seen = new Set<string>();
  for (const candidate of extractPhones(html, { html: true })) {
    if (candidate.phone === null) continue;
    const input = toPhoneInput(candidate.phone);
    if (seen.has(input.e164)) continue;
    seen.add(input.e164);
    found.push({
      e164: input.e164,
      raw: candidate.raw,
      origin: candidate.origin,
      type: input.type ?? 'unknown',
    });
  }
  return found;
}

function readSocials(socials: ExtractedSocials): EvidenceSocial[] {
  const found: EvidenceSocial[] = [];
  for (const profile of [socials.facebook, socials.instagram, socials.googleMaps]) {
    if (profile !== undefined) found.push({ network: profile.network, url: profile.url });
  }
  return found;
}

/**
 * The site the page is on, canonicalized.
 *
 * Not `extractWebsite`: that ranks *outbound* links and rejects same-domain
 * ones, which is right for a directory listing and exactly backwards here. The
 * website an enrichment page evidences is the one it is served from.
 */
function siteOf(finalUrl: string): {
  url: string;
  domain: string;
  registrableDomain: string;
  normalized: import('@/lib/contact').NormalizedWebsite;
} | null {
  try {
    const parsed = new URL(finalUrl);
    const canonical = canonicalizeWebsite(parsed.origin);
    return canonical === null
      ? null
      : {
          url: canonical.url,
          domain: canonical.domain,
          registrableDomain: canonical.registrableDomain || registrableDomain(canonical.domain),
          normalized: canonical,
        };
  } catch {
    return null;
  }
}

/** The first mobile or landline on the page, as a hint for the city resolver. */
function phoneHint(phones: readonly EvidencePhone[]): { phone?: string } {
  const first = phones[0];
  if (first === undefined) return {};
  const parsed = normalizePhone(first.e164);
  return 'error' in parsed ? {} : { phone: parsed.e164 };
}

/* -------------------------------------------------------------------------- */
/* The business name                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the page says the business is called, best evidence first.
 *
 * JSON-LD is a machine-readable statement by the site owner and is taken as
 * written. Everything below it is prose and goes through `stripPageLabel`,
 * including `og:site_name` — the tag is *supposed* to hold the site's name, and
 * on the Serbian web it routinely holds the page title instead
 * (`og:site_name = "Kontakt | Radno vreme | Informacije | Termodom"` on a real
 * fixture in this directory). Stripping a value that really is a bare name
 * leaves it untouched, so the check costs nothing when the tag is used
 * correctly.
 *
 * A `<h1>` that is only a page label (`Kontakt`) is skipped rather than
 * returned: it is the name of the page, not of the business.
 */
function readName($: CheerioAPI, businesses: readonly Record<string, unknown>[]): string | null {
  const structured = businesses.map((node) => stringOf(node['name'])).find(nonEmpty);
  if (structured !== undefined) return normalizeWhitespace(structured);

  const og = $('meta[property="og:site_name"]').attr('content');
  if (nonEmpty(og)) return stripPageLabel(normalizeWhitespace(og));

  const h1 = normalizeWhitespace($('h1').first().text());
  if (h1 !== '' && !TITLE_PAGE_LABEL.test(h1)) return stripPageLabel(h1);

  const title = normalizeWhitespace($('title').first().text());
  return title === '' ? null : stripPageLabel(title);
}

/**
 * `Kontakt | Radno vreme | Termodom` → `Termodom`.
 *
 * The **last** part that is not a page label, because a title is conventionally
 * written narrowest-first and the brand sits at the end — and because a Serbian
 * shop's title is often keyword soup (`Gipsane ploče | Fasade | OSB Ploče |
 * Cene | Termodom Online prodavnica`) where every earlier part is a product
 * category rather than a name.
 *
 * The rule is a guess, and it is allowed to be one. A title-derived name that
 * comes out wrong costs a *missed* enrichment, never a wrong merge: a name
 * never merges anything by itself, so the failure is always in the safe
 * direction. Anything cleverer here — picking the fragment that looks most
 * like the lead we are matching against — would manufacture the name match it
 * claims to have found.
 */
export function stripPageLabel(title: string): string {
  const parts = title
    .split(TITLE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return title;
  const kept = parts.filter((part) => !TITLE_PAGE_LABEL.test(part));
  return kept.length === 0 ? (parts[0] as string) : (kept[kept.length - 1] as string);
}

/* -------------------------------------------------------------------------- */
/* The address                                                                */
/* -------------------------------------------------------------------------- */

interface ReadAddress {
  readonly full: string | null;
  readonly postalCode: string | null;
  readonly locality: string | null;
  /** `structured` may corroborate a merge; `labelled` may not. See the file header. */
  readonly grade: 'structured' | 'labelled' | null;
}

const EMPTY_ADDRESS: ReadAddress = { full: null, postalCode: null, locality: null, grade: null };

function readAddress(
  $: CheerioAPI,
  businesses: readonly Record<string, unknown>[],
  text: string,
): ReadAddress {
  for (const node of businesses) {
    const parsed = addressFrom(node['address']);
    if (parsed.full !== null) return parsed;
  }
  const microdata = microdataAddress($);
  if (microdata.full !== null) return microdata;
  return labelledAddress(text);
}

/**
 * `Adresa: Klisanski put 167, 21000 Novi Sad` — the address a Serbian contact
 * page writes when it does not publish markup.
 *
 * The label is the whole guard. Without it the pattern would match any line
 * with a number and a capitalised word on it, which on a shop's page is every
 * product. With it, the page has told us what the line is, and the only thing
 * left to do is stop reading at the end of it.
 */
export function labelledAddress(text: string): ReadAddress {
  const match = ADDRESS_LABEL.exec(text);
  if (match === null) return EMPTY_ADDRESS;

  const raw = normalizeWhitespace(match[1] ?? '')
    // A label is a field boundary: whatever follows belongs to the next field.
    .split(/\b(?:tel(?:efon)?|mob(?:ilni)?|e-?mail|fax|faks|pib|mati[čc]ni)\b/i)[0];
  const value = normalizeWhitespace(raw ?? '').replace(/[;,\s]+$/, '');
  if (value.length < 6 || value.length > 120) return EMPTY_ADDRESS;
  // An address without a house number is a district, not a place we can compare.
  if (!/\d/.test(value)) return EMPTY_ADDRESS;

  const postal = /\b(\d{5})\b/.exec(value);
  const locality =
    postal === null ? null : normalizeWhitespace(value.slice(postal.index + postal[0].length));

  return {
    full: value,
    postalCode: postal?.[1] ?? null,
    locality: locality === null || locality === '' ? null : locality.replace(/^[,\s]+/, ''),
    grade: 'labelled',
  };
}

/** How a Serbian contact page labels the line the address is on. */
const ADDRESS_LABEL =
  /\b(?:adresa|adresu|address|lokacija|sedi[šs]te)\b\s*[:\-–]\s*([^\n]{6,160})/i;

function addressFrom(value: unknown): ReadAddress {
  if (typeof value === 'string') {
    const text = normalizeWhitespace(value);
    return text === ''
      ? EMPTY_ADDRESS
      : { full: text, postalCode: null, locality: null, grade: 'structured' };
  }
  if (value === null || typeof value !== 'object') return EMPTY_ADDRESS;
  const node = value as Record<string, unknown>;
  const street = stringOf(node['streetAddress']);
  const postalCode = stringOf(node['postalCode']);
  const locality = stringOf(node['addressLocality']);
  const parts = [street, postalCode, locality].filter(nonEmpty);
  if (parts.length === 0) return EMPTY_ADDRESS;
  return {
    full: normalizeWhitespace(parts.join(', ')),
    postalCode: nonEmpty(postalCode) ? postalCode : null,
    locality: nonEmpty(locality) ? normalizeWhitespace(locality) : null,
    grade: 'structured',
  };
}

/** schema.org microdata: `<span itemprop="streetAddress">`, and its siblings. */
function microdataAddress($: CheerioAPI): ReadAddress {
  const pick = (prop: string): string | null => {
    const text = normalizeWhitespace($(`[itemprop="${prop}"]`).first().text());
    return text === '' ? null : text;
  };
  const street = pick('streetAddress');
  const postalCode = pick('postalCode');
  const locality = pick('addressLocality');
  const parts = [street, postalCode, locality].filter((part): part is string => part !== null);
  if (parts.length === 0) return EMPTY_ADDRESS;
  return { full: parts.join(', '), postalCode, locality, grade: 'structured' };
}

/* -------------------------------------------------------------------------- */
/* How many businesses is this page about?                                    */
/* -------------------------------------------------------------------------- */

/**
 * Count the distinct businesses the page's own markup declares.
 *
 * Distinct **names**, not nodes: a site that emits an `Organization` and a
 * `LocalBusiness` for itself, or repeats its markup in a header and a footer,
 * is one business and must not be read as three. A directory's category page
 * emits one node per company and is read as what it is.
 *
 * A page with no structured markup counts as one and is caught, if it is a
 * listing, by `MAX_PHONES_ON_PAGE` instead.
 */
export function countBusinesses(
  $: CheerioAPI,
  businesses: readonly Record<string, unknown>[],
): number {
  const names = new Set<string>();
  for (const node of businesses) {
    const name = stringOf(node['name']);
    if (nonEmpty(name)) names.add(normalizeWhitespace(name).toLowerCase());
  }
  if (names.size > 0) return names.size;

  const microdata = $('[itemscope][itemtype]')
    .toArray()
    .filter((element) => BUSINESS_TYPE.test($(element).attr('itemtype') ?? '')).length;
  return Math.max(1, microdata);
}

/* -------------------------------------------------------------------------- */
/* JSON-LD                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every object in every `application/ld+json` block, flattened.
 *
 * `@graph`, top-level arrays and nested `mainEntity` are all used in the wild,
 * so the walk is generic rather than shape-aware. An unparseable block is
 * skipped: half of the JSON-LD on the Serbian web has a trailing comma in it,
 * and that is not a reason to fail a page.
 */
function jsonLdNodes($: CheerioAPI): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    nodes.push(value as Record<string, unknown>);
    for (const child of Object.values(value as Record<string, unknown>)) walk(child, depth + 1);
  };

  for (const element of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(element).text().trim();
    if (raw === '') continue;
    try {
      walk(JSON.parse(raw), 0);
    } catch {
      continue;
    }
  }
  return nodes;
}

function isBusinessNode(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((value) => typeof value === 'string' && BUSINESS_TYPE.test(value));
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function hrefs($: CheerioAPI): string[] {
  return $('a[href]')
    .toArray()
    .map((element) => $(element).attr('href') ?? '')
    .filter((href) => href !== '');
}

/**
 * The page as text, with `mailto:` hrefs appended so obfuscated addresses
 * survive.
 *
 * Tags become a **space**, rather than being dropped as cheerio's `.text()`
 * drops them. Without the separator, `…39 32</span><a>vukasin@termodom.rs</a>
 * <p>brzi…` reads as the single token `32vukasin@termodom.rsbrzi`, and the
 * email extractor is then asked to find an address inside a word that does not
 * contain one. The phone extractor already does this internally, for the same
 * reason.
 */
function textOf(html: string, $: CheerioAPI): string {
  const stripped = html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return [stripped, ...hrefs($).filter((href) => /^mailto:/i.test(href))].join('\n');
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmpty(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value.trim() !== '';
}

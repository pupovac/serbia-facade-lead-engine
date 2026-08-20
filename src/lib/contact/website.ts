/**
 * Website extraction and canonicalization.
 *
 * A listing page links to fifty hosts and exactly one of them is the
 * business's site. The rest are the directory itself, its foreign editions,
 * its social profiles, its advertisers, the agency that built it, and a
 * standards document linked from an accessibility tooltip — all of those are
 * real cases from the pages under `fixtures/`.
 *
 * The canonical form matters as much as the choice: the domain is a top-tier
 * deduplication key, so `HTTP://WWW.Firma.RS/`, `https://firma.rs` and
 * `firma.rs/?utm_source=x` must all collapse to one value, and canonicalizing
 * an already-canonical value must change nothing.
 */
import {
  GOOGLE_MAPS_HOST,
  INFRASTRUCTURE_DOMAINS,
  KNOWN_DIRECTORY_DOMAINS,
  SHORTENER_DOMAINS,
  SOCIAL_DOMAINS,
  VENDOR_CREDIT_TEXT,
} from './directories.js';
import {
  brandLabel,
  canonicalUrlString,
  isSameSite,
  looksLikeAdLink,
  normalizeHost,
  parseLooseUrl,
  registrableDomain,
} from './url.js';
import type {
  LinkCandidate,
  LinkInput,
  NormalizedWebsite,
  Rejection,
  WebsiteEvidence,
  WebsiteOptions,
  WebsiteRejectionRuleId,
} from './types.js';

/** Anchor text that says "this is the company's site". */
const WEBSITE_TEXT =
  /\b(web\s*sajt|websajt|sajt\s*firme|naš\s*sajt|nasem\s*sajtu|našem\s*sajtu|nas\s*sajt|internet\s*(stranica|prezentacija)|web\s*(site|stranica|adresa|prezentacija)|website|posetite|poseti\s*sajt|homepage|zvani[čc]n[ai])\b/i;

const SHARE_PATH =
  /(^|\/)(sharer|share|intent|sharearticle|submit|dialog\/(share|feed)|pin\/create)(\.php)?(\/|$)/i;

const DOCUMENT_EXTENSION =
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|jpe?g|png|gif|webp|svg|mp4|mp3|dwg)$/i;

/** Anchor text that is itself a domain, e.g. `www.bimax.rs` next to `https://www.bimax.rs`. */
const TEXT_IS_DOMAIN = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i;

function toCandidate(link: LinkInput): LinkCandidate {
  return typeof link === 'string' ? { href: link } : link;
}

/**
 * The canonical form of one URL, or `null` if it is not a URL at all.
 *
 * Idempotent by construction: everything the canonical form drops (scheme
 * case, `www.`, trailing slash, tracking parameters, fragment) is already
 * absent from its own output.
 */
export function canonicalizeWebsite(
  raw: string,
  evidence: WebsiteEvidence = 'ranked-first',
): NormalizedWebsite | null {
  const url = parseLooseUrl(raw);
  if (url === null) return null;
  const domain = normalizeHost(url.hostname);
  return {
    url: canonicalUrlString(url),
    domain,
    registrableDomain: registrableDomain(domain),
    raw,
    observedScheme: url.protocol === 'http:' ? 'http' : 'https',
    shortener: SHORTENER_DOMAINS.has(domain),
    evidence,
  };
}

function rejectionFor(
  url: URL,
  candidate: LinkCandidate,
  sourceDomain: string,
): WebsiteRejectionRuleId | null {
  const host = normalizeHost(url.hostname);
  const registrable = registrableDomain(host);
  const source = normalizeHost(sourceDomain);

  if (source !== '' && isSameSite(host, source)) return 'website_source_domain';
  if (SHARE_PATH.test(url.pathname)) return 'website_share_intent';
  if (SOCIAL_DOMAINS.has(registrable)) return 'website_social_network';
  // A Maps link pins the business but is not its site; the social extractor takes it.
  if (GOOGLE_MAPS_HOST.test(host)) return 'website_social_network';
  if (/(^|\.)google\.[a-z.]{2,7}$/.test(host)) return 'website_infrastructure';
  if (KNOWN_DIRECTORY_DOMAINS.has(registrable) || KNOWN_DIRECTORY_DOMAINS.has(host)) {
    return 'website_known_directory';
  }
  if (INFRASTRUCTURE_DOMAINS.has(registrable)) return 'website_infrastructure';
  if (
    source !== '' &&
    brandLabel(host) !== '' &&
    brandLabel(host) === brandLabel(source) &&
    registrable !== registrableDomain(source)
  ) {
    return 'website_source_sibling';
  }
  if (looksLikeAdLink(url)) return 'website_advertising_banner';
  if (VENDOR_CREDIT_TEXT.test(candidate.text ?? '')) return 'website_vendor_credit';
  if (DOCUMENT_EXTENSION.test(url.pathname)) return 'website_asset_or_document';
  return null;
}

function score(candidate: LinkCandidate, website: NormalizedWebsite): number {
  const text = (candidate.text ?? '').trim();
  let points = 0;
  if (WEBSITE_TEXT.test(text)) points += 5;
  if (TEXT_IS_DOMAIN.test(text)) {
    const textHost = normalizeHost(text.replace(/^https?:\/\//i, '').replace(/\/$/, ''));
    points += textHost === website.domain ? 4 : 2;
  }
  if (website.registrableDomain.endsWith('.rs')) points += 1;
  if (website.domain.split('.').length > 2) points -= 1; // a subdomain is usually a section, not the site
  return points;
}

function evidenceFor(candidate: LinkCandidate, only: boolean): WebsiteEvidence {
  const text = (candidate.text ?? '').trim();
  if (WEBSITE_TEXT.test(text)) return 'anchor-text-keyword';
  if (TEXT_IS_DOMAIN.test(text)) return 'anchor-text-is-domain';
  if (only) return 'only-external-link';
  return 'ranked-first';
}

/**
 * The business's own website out of a scraped link set, plus every candidate
 * that was dropped and the rule that dropped it.
 *
 * Ranking, once the rejections are applied: an anchor that says "web sajt"
 * beats an anchor whose text is the domain itself, which beats a bare link;
 * a Serbian TLD breaks a tie, a subdomain loses one; document order breaks
 * what is left.
 */
export function extractWebsiteWithRejections(
  links: readonly LinkInput[],
  opts: WebsiteOptions,
): { website: NormalizedWebsite | null; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const scored: Array<{
    website: NormalizedWebsite;
    points: number;
    candidate: LinkCandidate;
    index: number;
  }> = [];
  const seen = new Set<string>();
  /** A host that failed a rule once has failed it for the whole page — the second
   * banner to the same advertiser carries a different campaign string, not a different meaning. */
  const rejectedDomains = new Map<string, WebsiteRejectionRuleId>();

  links.forEach((link, index) => {
    const candidate = toCandidate(link);
    const url = parseLooseUrl(candidate.href);
    if (url === null) {
      if (candidate.href.trim() !== '') {
        rejected.push({ value: candidate.href, rule: 'website_unparseable' });
      }
      return;
    }
    const alreadyRejected = rejectedDomains.get(registrableDomain(url.hostname));
    if (alreadyRejected !== undefined) {
      rejected.push({ value: candidate.href, rule: alreadyRejected });
      return;
    }
    const rule = rejectionFor(url, candidate, opts.sourceDomain);
    if (rule !== null) {
      rejectedDomains.set(registrableDomain(url.hostname), rule);
      rejected.push({ value: candidate.href, rule });
      return;
    }
    const website = canonicalizeWebsite(candidate.href);
    if (website === null) {
      rejected.push({ value: candidate.href, rule: 'website_unparseable' });
      return;
    }
    if (seen.has(website.registrableDomain)) return;
    seen.add(website.registrableDomain);
    scored.push({ website, points: score(candidate, website), candidate, index });
  });

  if (scored.length === 0) return { website: null, rejected };

  // A page whose only outbound links are unlabelled is an advertiser sidebar.
  // Guessing one of them would attach a stranger's website to this lead.
  const labelled = scored.filter((entry) => evidenceFor(entry.candidate, false) !== 'ranked-first');
  if (labelled.length === 0 && scored.length > 1) {
    for (const entry of scored) {
      rejected.push({ value: entry.candidate.href, rule: 'website_ambiguous_link_farm' });
    }
    return { website: null, rejected };
  }

  scored.sort((a, b) => (b.points === a.points ? a.index - b.index : b.points - a.points));
  const best = scored[0];
  if (best === undefined) return { website: null, rejected };
  const website: NormalizedWebsite = {
    ...best.website,
    evidence: evidenceFor(best.candidate, scored.length === 1),
  };
  return { website, rejected };
}

/** The business's own website, or `null` when the link set contains none. */
export function extractWebsite(
  links: readonly LinkInput[],
  opts: WebsiteOptions,
): NormalizedWebsite | null {
  return extractWebsiteWithRejections(links, opts).website;
}

/** One HTTP response, reduced to what a redirect hop needs. */
export interface RedirectProbe {
  readonly status: number;
  readonly location: string | null;
}

/**
 * Follow exactly one redirect hop and record where the site really lives.
 *
 * The fetcher is injected: nothing in `src/lib` outside `db/` does I/O of its
 * own, and the test suite needs the hop without the network. Anything other
 * than a 3xx with a usable `Location` returns the website unchanged, and a hop
 * that lands on a social network or a directory is refused — a shortener
 * pointing at a Facebook page is not a website.
 */
export async function resolveFinalWebsite(
  website: NormalizedWebsite,
  probe: (url: string) => Promise<RedirectProbe>,
): Promise<NormalizedWebsite> {
  const response = await probe(website.url);
  if (response.status < 300 || response.status >= 400 || response.location === null) return website;

  const target = new URL(response.location, website.url).toString();
  const resolved = canonicalizeWebsite(target, website.evidence);
  if (resolved === null) return website;
  if (
    SOCIAL_DOMAINS.has(resolved.registrableDomain) ||
    KNOWN_DIRECTORY_DOMAINS.has(resolved.registrableDomain)
  ) {
    return website;
  }
  return { ...resolved, raw: website.raw };
}

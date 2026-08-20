/**
 * Which pages of a business's own site are worth fetching.
 *
 * The naive version guesses `/kontakt`, `/kontakt/`, `/kontakt.html`,
 * `/kontakt.php`, `/contact`, `/o-nama` … and spends most of its request budget
 * collecting 404s from sites that call the page something else. This one reads
 * the homepage's own navigation instead: one request buys the link the site
 * itself publishes, in whatever shape that site uses.
 *
 * Ranking, not filtering, because sites disagree about what the contact page is
 * called and a `kontakt` link is a better bet than an `o nama` link when both
 * exist and the budget only stretches to one.
 *
 * Serbian sites are written with diacritics, without them, and in Cyrillic, so
 * every comparison runs over the folded and transliterated form — `Пишите нам`,
 * `Pišite nam` and `pisite-nam` are one link.
 */
import type { CheerioAPI } from 'cheerio';
import { isSameSite } from '@/lib/contact';
import { toLatin } from '@/lib/text/cyrillic.js';
import { foldForComparison } from '@/lib/text/fold.js';
import { CONTACT_PAGE_KEYWORDS } from './thresholds.js';

/** Schemes and shapes that are never a page. */
const NOT_A_PAGE = /^(mailto:|tel:|javascript:|sms:|callto:|#)/i;

/** Files a link can point at that are not HTML. */
const NOT_HTML = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4|mp3)$/i;

export interface ContactLink {
  /** Absolute, with the fragment stripped. */
  readonly url: string;
  /** The anchor text, whitespace-collapsed. */
  readonly text: string;
  /** Higher is a better bet. From `CONTACT_PAGE_KEYWORDS`. */
  readonly rank: number;
  /** Which keyword matched — in the log line when the page turns out to be useless. */
  readonly keyword: string;
}

/**
 * The contact-bearing links on a page, best first.
 *
 * Same-site only: an outbound link is somebody else's contact page, and the
 * whole trust argument of the own-site path is that the business publishes the
 * page. The page the links were read from is excluded — it has already been
 * fetched and read.
 */
export function contactLinks($: CheerioAPI, pageUrl: string, limit: number): ContactLink[] {
  const base = safeUrl(pageUrl);
  if (base === null) return [];

  const best = new Map<string, ContactLink>();
  for (const element of $('a[href]').toArray()) {
    const href = ($(element).attr('href') ?? '').trim();
    if (href === '' || NOT_A_PAGE.test(href)) continue;

    const resolved = safeUrl(href, base);
    if (resolved === null) continue;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (!isSameSite(resolved.hostname, base.hostname)) continue;
    if (NOT_HTML.test(resolved.pathname)) continue;

    resolved.hash = '';
    const url = resolved.toString();
    if (sameTarget(url, pageUrl)) continue;

    const text = ($(element).text() ?? '').replace(/\s+/g, ' ').trim();
    const scored = rank(resolved.pathname + resolved.search, text);
    if (scored === null) continue;

    const existing = best.get(url);
    if (existing === undefined || existing.rank < scored.rank) {
      best.set(url, { url, text, rank: scored.rank, keyword: scored.keyword });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.rank - a.rank || a.url.localeCompare(b.url))
    .slice(0, limit);
}

/**
 * The best keyword a link matches, in its href or its anchor text.
 *
 * The href is worth more than the anchor text: `/kontakt` is what the site
 * called the page, while an anchor reading "kontakt" can be a footer link to a
 * form on the same page.
 */
function rank(path: string, text: string): { rank: number; keyword: string } | null {
  const haystackPath = fold(path);
  const haystackText = fold(text);
  let best: { rank: number; keyword: string } | null = null;

  for (const [keyword, weight] of CONTACT_PAGE_KEYWORDS) {
    const folded = fold(keyword);
    const inPath = haystackPath.includes(folded);
    const inText = haystackText.includes(folded);
    if (!inPath && !inText) continue;
    const score = inPath ? weight : weight - 20;
    if (best === null || score > best.rank) best = { rank: score, keyword };
  }
  return best;
}

/** Cyrillic → Latin → diacritics folded → punctuation flattened to a space. */
function fold(value: string): string {
  return foldForComparison(toLatin(value)).replace(/[^a-z0-9]+/g, ' ');
}

function safeUrl(value: string, base?: URL): URL | null {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
}

/** `https://firma.rs/` and `https://firma.rs` are the same page. */
function sameTarget(a: string, b: string): boolean {
  const strip = (value: string): string => value.replace(/#.*$/, '').replace(/\/+$/, '');
  return strip(a) === strip(b);
}

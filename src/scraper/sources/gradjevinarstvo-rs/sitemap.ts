/**
 * `gradjevinarstvo-rs` — reading the company sitemap.
 *
 * The sitemap is not a convenience here, it is the only sanctioned way to
 * enumerate this source. `robots.txt` disallows `/Pretraga/GetFirme*`, and that
 * endpoint is exactly what the category pages' "Prikaži više" button calls, so
 * a category can never be paged past its first twenty companies without
 * breaking the rule. The same `robots.txt` publishes
 * `Sitemap: https://www.gradjevinarstvo.rs/sitemap_index.xml`, and
 * `/firme-sitemap` under it lists every company page. The permitted route is
 * also the complete one.
 *
 * Parsing is regex over `<loc>` rather than a real XML parse for one reason:
 * the document is 2 MB of a single repeated element, and its only interesting
 * content is the URL. `<changefreq>daily</changefreq>` and a `<lastmod>` that
 * is the same date on all 11,291 entries carry no information — freshness has
 * to come from our own `crawl_state`, not from the source's claim.
 */

/** One company, as the sitemap names it. */
export interface FirmRef {
  /** The numeric id in `/firme/{id}/{slug}` — stable across a slug rename. */
  readonly id: number;
  readonly slug: string;
  readonly url: string;
}

const LOC = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

/** `https://www.gradjevinarstvo.rs/firme/5143/popovic` → `{ id: 5143, slug: 'popovic' }`. */
const FIRM_PATH = /^\/firme\/(\d+)\/([^/?#]+)\/?$/;

/**
 * Every company URL in the document, de-duplicated and ordered by id.
 *
 * Non-company `<loc>` entries are dropped rather than guessed at: the file is
 * advertised as the company sitemap, but a site that later merges its sitemaps
 * should not turn every article into a lead. `skipped` counts what was dropped
 * so the log can say so instead of the count quietly shrinking.
 */
export function parseFirmSitemap(
  xml: string,
  baseUrl: string,
): { readonly firms: readonly FirmRef[]; readonly skipped: number } {
  const byId = new Map<number, FirmRef>();
  let skipped = 0;

  for (const match of xml.matchAll(LOC)) {
    const raw = (match[1] ?? '').replace(/&amp;/g, '&').trim();
    if (raw === '') continue;

    let path: string;
    try {
      path = new URL(raw, baseUrl).pathname;
    } catch {
      skipped += 1;
      continue;
    }

    const parts = FIRM_PATH.exec(path);
    if (parts === null) {
      skipped += 1;
      continue;
    }

    const id = Number(parts[1]);
    const slug = parts[2] as string;
    // The same company listed twice is one company. Keeping the first sighting
    // makes the walk order deterministic, which is what the resume cursor is
    // indexed against.
    if (byId.has(id)) continue;
    byId.set(id, { id, slug, url: `${baseUrl}/firme/${id}/${slug}` });
  }

  const firms = [...byId.values()].sort((a, b) => a.id - b.id);
  return { firms, skipped };
}

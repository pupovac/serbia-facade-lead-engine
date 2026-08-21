/**
 * The activity codes this adapter walks, and the two indexes that reach them.
 *
 * Kompanije.net files every company under one KD-2010 activity code, and both
 * of its indexes are keyed by that code rather than by a search term. That is
 * the whole reason this source is cheap: there is no query to guess, no name to
 * resolve, and no join. A category is an enumeration.
 *
 * Each code is addressed twice, because the site has two surfaces of different
 * vintages:
 *
 * - **modern** — `/Srbija/l<listId>_<slug>.html`, one static page holding every
 *   detail link. The `listId` is stable; the slug is not, so `discover` reads
 *   it off the `GRAĐEVINARSTVO` index rather than hard-coding it here.
 * - **legacy** — `/preduzetnici/preduzetnici.php?delatnost=<legacyCode>`, the
 *   sole-trader index, addressed by the same code padded to six digits.
 *
 * `measuredRecords` / `measuredLegacyRecords` are FUZZ-41's counts, re-verified
 * on 2026-08-21. They are documentation and a sanity check in the run log, not
 * a filter: a category that returns wildly fewer links than this is worth
 * seeing in the log line, and a category that returns none raises.
 */

/** Which of the site's two indexes a record came from. Stamped on every record. */
export type Surface = 'modern' | 'legacy';

export interface ActivityCategory {
  /** KD-2010 code as the detail page prints it, dotted: `43.31`. */
  readonly code: string;
  /** The 4-digit form the detail page's `Šifra delatnosti:` field carries. */
  readonly sifra: string;
  /** `l70` — the modern index's stable id for this code. */
  readonly listId: string;
  /** `433100` — the legacy index's `delatnost` parameter. */
  readonly legacyCode: string;
  /** The site's own category name, as the index prints it. */
  readonly name: string;
  /**
   * `core` is the five codes FUZZ-45 scoped in and the default crawl.
   * `adjacent` is crawled only when named with `--query`; see the README for
   * the measured overlap that decision waits on.
   */
  readonly tier: 'core' | 'adjacent';
  /** Detail links on the modern category page when FUZZ-41 counted them. */
  readonly measuredRecords: number;
  /** Detail links on the legacy index for the same code, counted 2026-08-21. */
  readonly measuredLegacyRecords: number;
}

/**
 * Crawl order is by expected facade yield rather than by code, so a run cut
 * short by `--limit` or the request budget has still covered the categories
 * where a fasader is most likely to be.
 */
export const CATEGORIES: readonly ActivityCategory[] = [
  {
    code: '43.31',
    sifra: '4331',
    listId: 'l70',
    legacyCode: '433100',
    name: 'Malterisanje',
    tier: 'core',
    measuredRecords: 900,
    measuredLegacyRecords: 852,
  },
  {
    code: '43.39',
    sifra: '4339',
    listId: 'l74',
    legacyCode: '433900',
    name: 'Ostali završni radovi',
    tier: 'core',
    measuredRecords: 2880,
    measuredLegacyRecords: 2340,
  },
  {
    code: '43.99',
    sifra: '4399',
    listId: 'l76',
    legacyCode: '439900',
    name: 'Ostali nepomenuti specifični građevinski radovi',
    tier: 'core',
    measuredRecords: 2779,
    measuredLegacyRecords: 1757,
  },
  {
    code: '43.34',
    sifra: '4334',
    listId: 'l73',
    legacyCode: '433400',
    name: 'Bojenje i zastakljivanje',
    tier: 'core',
    measuredRecords: 2619,
    measuredLegacyRecords: 2558,
  },
  {
    code: '43.29',
    sifra: '4329',
    listId: 'l69',
    legacyCode: '432900',
    name: 'Ostali instalacioni radovi u građevinarstvu',
    tier: 'core',
    measuredRecords: 652,
    measuredLegacyRecords: 494,
  },
  // Adjacent. Opt-in with `--query 43.33` / `--query l72`, because none of them
  // is a facade trade by name and `41.20` is general building construction —
  // the issue's instruction is to decide these on measured overlap, not on the
  // assumption that a roofer sometimes renders a wall.
  {
    code: '43.33',
    sifra: '4333',
    listId: 'l72',
    legacyCode: '433300',
    name: 'Postavljanje podnih i zidnih obloga',
    tier: 'adjacent',
    measuredRecords: 2121,
    measuredLegacyRecords: 0,
  },
  {
    code: '43.32',
    sifra: '4332',
    listId: 'l71',
    legacyCode: '433200',
    name: 'Ugradnja stolarije',
    tier: 'adjacent',
    measuredRecords: 551,
    measuredLegacyRecords: 0,
  },
  {
    code: '43.91',
    sifra: '4391',
    listId: 'l75',
    legacyCode: '439100',
    name: 'Krovni radovi',
    tier: 'adjacent',
    measuredRecords: 329,
    measuredLegacyRecords: 0,
  },
  {
    code: '41.20',
    sifra: '4120',
    listId: 'l56',
    legacyCode: '412000',
    name: 'Izgradnja stambenih i nestambenih zgrada',
    tier: 'adjacent',
    measuredRecords: 5663,
    measuredLegacyRecords: 0,
  },
];

/**
 * Resolve the categories one run should walk.
 *
 * With no `--query`, that is the five core codes. `--query` selects by code
 * (`43.33`, `4333`) or by list id (`l72`), which is what makes an adjacent
 * category a flag rather than a code change; `--query legacy` is handled by
 * `index.ts` and is not a category.
 */
export function selectCategories(queries: readonly string[]): readonly ActivityCategory[] {
  const wanted = queries
    .map((query) => query.trim().toLowerCase())
    .filter((query) => query !== '' && query !== 'legacy' && query !== 'modern');
  if (wanted.length === 0) return CATEGORIES.filter((category) => category.tier === 'core');

  const selected = CATEGORIES.filter((category) =>
    wanted.some(
      (query) =>
        query === category.listId ||
        query === category.code ||
        query === category.sifra ||
        query === category.legacyCode,
    ),
  );
  // An unrecognised `--query` must not silently fall back to the core five: a
  // run asked for `--query 43.21` and given `43.31` reports numbers for a
  // category nobody asked about.
  const unknown = wanted.filter(
    (query) =>
      !CATEGORIES.some(
        (category) =>
          query === category.listId ||
          query === category.code ||
          query === category.sifra ||
          query === category.legacyCode,
      ),
  );
  if (unknown.length > 0) {
    throw new Error(
      `kompanije-net: unknown --query ${unknown.join(', ')}. ` +
        `Use an activity code (43.31), a šifra (4331) or a list id (l70) from ` +
        CATEGORIES.map((category) => category.code).join(', '),
    );
  }
  return selected;
}

/** Which surfaces a run walks. Modern always; legacy only when asked for. */
export function selectSurfaces(queries: readonly string[]): readonly Surface[] {
  const asked = queries.map((query) => query.trim().toLowerCase());
  return asked.includes('legacy') ? ['modern', 'legacy'] : ['modern'];
}

/** `code:43.31|surface:modern` — one scope per (category × surface). */
export function scopeKeyOf(category: ActivityCategory, surface: Surface): string {
  return `code:${category.code}|surface:${surface}`;
}

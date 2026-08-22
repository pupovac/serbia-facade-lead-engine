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
   * `core` is the five codes FUZZ-45 scoped in and the default crawl. It is
   * also the only tier that claims `assertedType` — being in a core category
   * *is* the evidence a fasader is a fasader.
   *
   * `adjacent` is crawled only when named with `--query`, and asserts nothing.
   * See `measuredFacadeNamedShare` for what the sample says about each.
   */
  readonly tier: 'core' | 'adjacent';
  /** Detail links on the modern category page when FUZZ-41 counted them. */
  readonly measuredRecords: number;
  /** Detail links on the legacy index for the same code, counted 2026-08-21. */
  readonly measuredLegacyRecords: number;
  /**
   * Share of sampled records whose *registered name* names a facade trade —
   * `fasad`, `termoizolac`, `stiropor`, `demit`, `izolacij`, `malteris`.
   *
   * Measured by FUZZ-45 on 400 records per core code and 80 per adjacent one.
   * It is a floor, not a rate: a sole trader called `SZR MILAN` reveals nothing
   * and counts against every code equally, so the numbers are comparable across
   * codes even though none of them is the true facade share. This is the
   * evidence the adjacent-code decision rests on — see the README.
   */
  readonly measuredFacadeNamedShare: number;
  /** Records with a phone in the same sample, as a share. */
  readonly measuredPhoneFill: number;
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
    measuredFacadeNamedShare: 0.13,
    measuredPhoneFill: 0.75,
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
    measuredFacadeNamedShare: 0.02,
    measuredPhoneFill: 0.65,
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
    measuredFacadeNamedShare: 0.02,
    measuredPhoneFill: 0.56,
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
    measuredFacadeNamedShare: 0.1,
    measuredPhoneFill: 0.73,
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
    measuredFacadeNamedShare: 0.05,
    measuredPhoneFill: 0.51,
  },
  // Adjacent, opt-in with `--query 43.91` / `--query l75`, and now decided on
  // evidence rather than on the assumption that a roofer sometimes renders a
  // wall. FUZZ-45 sampled 80 records from each:
  //
  //   43.91 Krovni radovi                8% facade-named — WORTH CRAWLING
  //   43.32 Ugradnja stolarije            1%
  //   43.33 Postavljanje podnih obloga    0%
  //   41.20 Izgradnja zgrada              0% — and 5,663 records of it
  //
  // `43.91` scores above two of the five core codes (43.39 and 43.99 both come
  // in at 2%) and costs 329 records, about eight minutes. The other three earn
  // nothing: `41.20` in particular is 5,663 records at 51% phone fill and not
  // one facade-named business in 80, exactly as the issue predicted.
  //
  // None of them is promoted to `core`, because `core` also means claiming
  // `assertedType: FACADE_CONTRACTOR`, and 92% of `43.91` is roofing. It is a
  // category worth reading and letting `src/lib/classify` judge.
  {
    code: '43.33',
    sifra: '4333',
    listId: 'l72',
    legacyCode: '433300',
    name: 'Postavljanje podnih i zidnih obloga',
    tier: 'adjacent',
    measuredRecords: 2121,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: 0.0,
    measuredPhoneFill: 0.81,
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
    measuredFacadeNamedShare: 0.01,
    measuredPhoneFill: 0.79,
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
    measuredFacadeNamedShare: 0.08,
    measuredPhoneFill: 0.57,
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
    measuredFacadeNamedShare: 0.0,
    measuredPhoneFill: 0.51,
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

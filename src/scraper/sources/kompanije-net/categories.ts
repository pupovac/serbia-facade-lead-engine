/**
 * The activity codes this adapter walks, and the indexes that reach them.
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
 *   it off the code's *section* index rather than hard-coding it here.
 * - **legacy** — `/preduzetnici/preduzetnici.php?delatnost=<legacyCode>`, the
 *   sole-trader index, addressed by the same code padded to six digits.
 *
 * The section is `sectionId`, and it is not always `d4 GRAĐEVINARSTVO`. FUZZ-45
 * only ever crawled construction codes, so one section index served the whole
 * adapter; FUZZ-46's six codes are spread over four sections — mortar
 * production is in `d6 INDUSTRIJA`, the builders' merchant in `d20 TRGOVINA NA
 * VELIKO`, architects and engineers in `d24 USLUŽNE DELATNOSTI`. Every section
 * index is reached from the country index and every slug in the chain is read
 * rather than assembled, which is what keeps a renamed heading from 404-ing a
 * five-hour crawl.
 *
 * `measuredRecords` / `measuredLegacyRecords` are counts taken off the live
 * index pages — FUZZ-41's for the core five, re-verified 2026-08-21, and
 * FUZZ-46's for the widened six, counted 2026-08-22. They are documentation and
 * a sanity check in the run log, not a filter: a category that returns wildly
 * fewer links than this is worth seeing in the log line, and a category that
 * returns none raises.
 */
import type { LeadType } from '@/lib/queries';

/** Which of the site's two indexes a record came from. Stamped on every record. */
export type Surface = 'modern' | 'legacy';

/**
 * Why a code is in the table.
 *
 * - `core` — FUZZ-45's five contractor trades, the default crawl, and the only
 *   tier where being in the category is itself evidence of a fasader.
 * - `widened` — FUZZ-46's six. Crawled in full, no name pre-filtering, and
 *   selected as a set with `--query widened`. Only `46.73` asserts anything.
 * - `adjacent` — sampled by FUZZ-45 and left opt-in by code. Asserts nothing.
 */
export type CategoryTier = 'core' | 'widened' | 'adjacent';

/** The tier words `--query` accepts in place of a code. */
export const TIER_QUERIES: readonly CategoryTier[] = ['core', 'widened', 'adjacent'];

export interface ActivityCategory {
  /** KD-2010 code as the detail page prints it, dotted: `43.31`. */
  readonly code: string;
  /** The 4-digit form the detail page's `Šifra delatnosti:` field carries. */
  readonly sifra: string;
  /** `l70` — the modern index's stable id for this code. */
  readonly listId: string;
  /** `d4` — the section index that links to this code's category page. */
  readonly sectionId: string;
  /** `433100` — the legacy index's `delatnost` parameter. */
  readonly legacyCode: string;
  /** The site's own category name, as the index prints it. */
  readonly name: string;
  readonly tier: CategoryTier;
  /**
   * What being filed under this code *proves*, or `null` when it proves nothing
   * about either buyer group.
   *
   * This is the whole classification decision, per code, in one field. The
   * FUZZ-38 epic rule — "an adapter under this epic sets `FACADE_CONTRACTOR`
   * from source provenance" — holds for `43.31 Malterisanje`, because rendering
   * a wall *is* the trade. It does not hold for `71.12 Inženjerske delatnosti`,
   * and asserting it there would file 3,286 engineering firms and 5,663 general
   * builders in the corpus as facade contractors. A `null` sends the record
   * through `src/lib/classify` on its name like any general directory record,
   * and most of those will land `UNCLASSIFIED` — which is correct, because for
   * these codes the activity code is the segmentation signal, not the name.
   */
  readonly assertedType: LeadType | null;
  /** Detail links on the modern category page when they were last counted. */
  readonly measuredRecords: number;
  /** Detail links on the legacy index for the same code. `0` where uncounted. */
  readonly measuredLegacyRecords: number;
  /**
   * Share of sampled records whose *registered name* names a facade trade —
   * `fasad`, `termoizolac`, `stiropor`, `demit`, `izolacij`, `malteris`.
   *
   * Measured by FUZZ-45 on 400 records per core code and 80 per adjacent one.
   * It is a floor, not a rate: a sole trader called `SZR MILAN` reveals nothing
   * and counts against every code equally, so the numbers are comparable across
   * codes even though none of them is the true facade share.
   *
   * `null` on the codes FUZZ-46 added on purpose. The metric decided what
   * FUZZ-45 skipped and it is **superseded** for the widened six: the member
   * asked for every record in those codes regardless of name, because a builder
   * trading as `GRADNJA DOO` is exactly the lead a name filter drops. Nothing
   * in this file reads the field; it is evidence for a human.
   */
  readonly measuredFacadeNamedShare: number | null;
  /** Records with a phone in the same sample, as a share. `null` where unsampled. */
  readonly measuredPhoneFill: number | null;
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
    sectionId: 'd4',
    legacyCode: '433100',
    name: 'Malterisanje',
    tier: 'core',
    assertedType: 'FACADE_CONTRACTOR',
    measuredRecords: 900,
    measuredLegacyRecords: 852,
    measuredFacadeNamedShare: 0.13,
    measuredPhoneFill: 0.75,
  },
  {
    code: '43.39',
    sifra: '4339',
    listId: 'l74',
    sectionId: 'd4',
    legacyCode: '433900',
    name: 'Ostali završni radovi',
    tier: 'core',
    assertedType: 'FACADE_CONTRACTOR',
    measuredRecords: 2880,
    measuredLegacyRecords: 2340,
    measuredFacadeNamedShare: 0.02,
    measuredPhoneFill: 0.65,
  },
  {
    code: '43.99',
    sifra: '4399',
    listId: 'l76',
    sectionId: 'd4',
    legacyCode: '439900',
    name: 'Ostali nepomenuti specifični građevinski radovi',
    tier: 'core',
    assertedType: 'FACADE_CONTRACTOR',
    measuredRecords: 2779,
    measuredLegacyRecords: 1757,
    measuredFacadeNamedShare: 0.02,
    measuredPhoneFill: 0.56,
  },
  {
    code: '43.34',
    sifra: '4334',
    listId: 'l73',
    sectionId: 'd4',
    legacyCode: '433400',
    name: 'Bojenje i zastakljivanje',
    tier: 'core',
    assertedType: 'FACADE_CONTRACTOR',
    measuredRecords: 2619,
    measuredLegacyRecords: 2558,
    measuredFacadeNamedShare: 0.1,
    measuredPhoneFill: 0.73,
  },
  {
    code: '43.29',
    sifra: '4329',
    listId: 'l69',
    sectionId: 'd4',
    legacyCode: '432900',
    name: 'Ostali instalacioni radovi u građevinarstvu',
    tier: 'core',
    assertedType: 'FACADE_CONTRACTOR',
    measuredRecords: 652,
    measuredLegacyRecords: 494,
    measuredFacadeNamedShare: 0.05,
    measuredPhoneFill: 0.51,
  },

  // ---------------------------------------------------------------------- //
  // FUZZ-46 — the widened six. `--query widened` walks the set; `--query
  // 71.12` walks one. 13,095 records, crawled in full with no name filter.
  //
  // Only `46.73` claims a buyer group, and it claims the *other* one: the code
  // is the definition of a builders' merchant. `41.20` and `43.33` are read by
  // `src/lib/classify` like any directory record. `23.64`, `71.11` and `71.12`
  // are neither buyer group — they are a distinct segment, and `activity_code`
  // on the lead is what identifies them, which is why FUZZ-46 carried that
  // field to the database at the same time as it widened the crawl.
  // ---------------------------------------------------------------------- //
  {
    code: '23.64',
    sifra: '2364',
    listId: 'l197',
    sectionId: 'd6',
    legacyCode: '236400',
    name: 'Proizvodnja maltera',
    tier: 'widened',
    // Mortar producers are resellers and partners, not a buyer group.
    assertedType: null,
    measuredRecords: 40,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: null,
    measuredPhoneFill: null,
  },
  {
    code: '46.73',
    sifra: '4673',
    listId: 'l548',
    sectionId: 'd20',
    legacyCode: '467300',
    name: 'Trgovina na veliko drvetom i građ materijalom',
    tier: 'widened',
    // Buyer group 2, by definition of the code. The one assertion FUZZ-46 adds.
    assertedType: 'CONSTRUCTION_MATERIAL_STORE',
    measuredRecords: 1486,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: null,
    measuredPhoneFill: null,
  },
  {
    code: '43.33',
    sifra: '4333',
    listId: 'l72',
    sectionId: 'd4',
    legacyCode: '433300',
    name: 'Postavljanje podnih i zidnih obloga',
    tier: 'widened',
    assertedType: null,
    measuredRecords: 2121,
    measuredLegacyRecords: 0,
    // FUZZ-45's sample, kept for the record and no longer acted on.
    measuredFacadeNamedShare: 0.0,
    measuredPhoneFill: 0.81,
  },
  {
    code: '41.20',
    sifra: '4120',
    listId: 'l56',
    sectionId: 'd4',
    legacyCode: '412000',
    name: 'Izgradnja stambenih i nestambenih zgrada',
    tier: 'widened',
    assertedType: null,
    measuredRecords: 5663,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: 0.0,
    measuredPhoneFill: 0.51,
  },
  {
    code: '71.11',
    sifra: '7111',
    listId: 'l573',
    sectionId: 'd24',
    legacyCode: '711100',
    name: 'Arhitektonska delatnost',
    tier: 'widened',
    assertedType: null,
    measuredRecords: 499,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: null,
    measuredPhoneFill: null,
  },
  {
    code: '71.12',
    sifra: '7112',
    listId: 'l574',
    sectionId: 'd24',
    legacyCode: '711200',
    name: 'Inženjerske delatnosti i tehničko savetovanje',
    tier: 'widened',
    assertedType: null,
    measuredRecords: 3286,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: null,
    measuredPhoneFill: null,
  },

  // Adjacent, opt-in with `--query 43.91` / `--query l75`, and decided on
  // evidence rather than on the assumption that a roofer sometimes renders a
  // wall. FUZZ-45 sampled 80 records from each:
  //
  //   43.91 Krovni radovi                8% facade-named — WORTH CRAWLING
  //   43.32 Ugradnja stolarije            1%
  //
  // `43.91` scores above two of the five core codes (43.39 and 43.99 both come
  // in at 2%) and costs 329 records, about eight minutes. Neither is promoted
  // to `core`, because `core` also means claiming `FACADE_CONTRACTOR`, and 92%
  // of `43.91` is roofing. It is a category worth reading and letting
  // `src/lib/classify` judge.
  {
    code: '43.32',
    sifra: '4332',
    listId: 'l71',
    sectionId: 'd4',
    legacyCode: '433200',
    name: 'Ugradnja stolarije',
    tier: 'adjacent',
    assertedType: null,
    measuredRecords: 551,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: 0.01,
    measuredPhoneFill: 0.79,
  },
  {
    code: '43.91',
    sifra: '4391',
    listId: 'l75',
    sectionId: 'd4',
    legacyCode: '439100',
    name: 'Krovni radovi',
    tier: 'adjacent',
    assertedType: null,
    measuredRecords: 329,
    measuredLegacyRecords: 0,
    measuredFacadeNamedShare: 0.08,
    measuredPhoneFill: 0.57,
  },
];

/** `--query` words that select surfaces or tiers rather than one category. */
const SURFACE_QUERIES: ReadonlySet<string> = new Set(['legacy', 'modern']);
const TIER_SET: ReadonlySet<string> = new Set<string>(TIER_QUERIES);

function matches(category: ActivityCategory, query: string): boolean {
  return (
    query === category.listId ||
    query === category.code ||
    query === category.sifra ||
    query === category.legacyCode
  );
}

/**
 * Resolve the categories one run should walk.
 *
 * With no `--query`, that is the five core codes — FUZZ-45's default, unchanged.
 * `--query` selects either
 *
 * - **one category**, by code (`43.33`), šifra (`4333`) or list id (`l72`); or
 * - **a whole tier**, by name: `core`, `widened`, `adjacent`.
 *
 * so FUZZ-46's six codes are reachable individually and as a set without a code
 * change. `--query legacy` is a surface, handled by `index.ts`, not a category.
 */
export function selectCategories(queries: readonly string[]): readonly ActivityCategory[] {
  const wanted = queries
    .map((query) => query.trim().toLowerCase())
    .filter((query) => query !== '' && !SURFACE_QUERIES.has(query));
  if (wanted.length === 0) return CATEGORIES.filter((category) => category.tier === 'core');

  const tiers = new Set(wanted.filter((query) => TIER_SET.has(query)));
  const codes = wanted.filter((query) => !TIER_SET.has(query));

  const selected = CATEGORIES.filter(
    (category) => tiers.has(category.tier) || codes.some((query) => matches(category, query)),
  );
  // An unrecognised `--query` must not silently fall back to the core five: a
  // run asked for `--query 43.21` and given `43.31` reports numbers for a
  // category nobody asked about.
  const unknown = codes.filter((query) => !CATEGORIES.some((category) => matches(category, query)));
  if (unknown.length > 0) {
    throw new Error(
      `kompanije-net: unknown --query ${unknown.join(', ')}. ` +
        `Use an activity code (43.31), a šifra (4331), a list id (l70) from ` +
        CATEGORIES.map((category) => category.code).join(', ') +
        `, or a tier (${TIER_QUERIES.join(', ')})`,
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

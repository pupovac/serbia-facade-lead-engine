/**
 * Which trade categories this adapter walks, and why the neighbours are not in
 * the list.
 *
 * The site files every profile under exactly one trade — measured, not assumed:
 * across the five construction categories sampled on 2026-08-21, `fasader`,
 * `izolater`, `moler`, `zidar` and `gipsar` share **zero** master ids. So the
 * choice of categories is the whole scope of the source, and a category left
 * out is a population that is never reached by any other route here.
 *
 * ## The adjacent categories were checked, and they are empty for us
 *
 * FUZZ-40 asked whether facade crews hide under a neighbouring trade. They do
 * not, and the reason is structural rather than statistical: **the occupation
 * checklist a tradesman fills in is scoped to their trade.** A `moler` may pick
 * from `Špatulat`, `Farbanje stolarije`, `Krečenje`; a `zidar` from `Zidanje u
 * visokogradnji`, `Malterisanje`; a `gipsar` from `Postavljanje gipsanih
 * ploča`, `Spuštanje plafona`. None of those lists contains a facade or
 * insulation option at all, so a facade crew registered as a moler has no way
 * to say so and no reason to be found.
 *
 * 30 profiles were sampled from each of the three, spread evenly across the
 * rating-sorted listing — 90 profiles, **0** with any facade or insulation
 * occupation. Walking them would cost ~2,300 requests for records whose only
 * facade evidence would be a guess off a personal name, which is the exact
 * failure the pilot already measured.
 *
 * ## `izolater` is in, with its numbers stated
 *
 * Insulation installers are the adjacent trade that *does* overlap: thermal
 * insulation on a wall is the ETICS job our panel replaces. Of the 33 profiles,
 * 12 list `Termoizolacija`; the rest list `Drenaža` (20) and `Hidroizolacija`
 * (5), which are drainage and waterproofing — the same crews, a different job.
 * They are emitted with the category recorded, so a reviewer who wants only the
 * thermal ones can filter on it rather than re-crawl.
 */

/** A trade category on the site, and what it establishes about the businesses in it. */
export interface TradeCategory {
  /** The URL segment under `/gradjevinski-radovi/`. */
  readonly slug: string;
  /** The label the site prints for it. */
  readonly label: string;
  /**
   * The sentence that justifies the source-asserted classification, quoted into
   * every record's classification evidence.
   */
  readonly assertion: string;
  /** Records counted on the category's own listing header, 2026-08-21. */
  readonly measuredCount: number;
}

export const CATEGORIES: readonly TradeCategory[] = [
  {
    slug: 'fasader',
    label: 'Fasader',
    assertion: 'listed under gradjevinski-radovi/fasader, the site’s facade-installer category',
    measuredCount: 56,
  },
  {
    slug: 'izolater',
    label: 'Izolater',
    assertion:
      'listed under gradjevinski-radovi/izolater, the site’s insulation-installer category',
    measuredCount: 33,
  },
];

/**
 * Categories deliberately not walked, kept in code so the next person does not
 * re-run the same sample to find out.
 */
export const REJECTED_CATEGORIES: ReadonlyArray<{
  readonly slug: string;
  readonly listed: number;
  readonly sampled: number;
  readonly withFacadeOccupation: number;
}> = [
  { slug: 'moler', listed: 456, sampled: 30, withFacadeOccupation: 0 },
  { slug: 'zidar', listed: 65, sampled: 30, withFacadeOccupation: 0 },
  { slug: 'gipsar', listed: 260, sampled: 30, withFacadeOccupation: 0 },
];

export function categoryBySlug(slug: string): TradeCategory | undefined {
  return CATEGORIES.find((category) => category.slug === slug);
}

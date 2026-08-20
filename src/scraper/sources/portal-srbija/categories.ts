/**
 * The Portal Srbija categories this adapter crawls.
 *
 * The nine slugs are the facade-relevant ones FUZZ-4 measured and named in
 * `research/sources-contractors.json`; the labels are the site's own `h1`,
 * copied verbatim including its typos (`Čisćenje`) and its missing diacritics
 * (`Grubi gradjevinski radovi`), because a category label that does not match
 * the page is a label nobody can check.
 *
 * `focus` is not used to filter anything — `src/lib/classify` decides what a
 * company is. It records what the category is expected to yield so a later run
 * can prune the set against measured per-category numbers rather than against
 * a guess.
 */

export interface Category {
  /** The path segment: `https://www.portal-srbija.com/<slug>`. */
  readonly slug: string;
  /** The category name as the site prints it in `h1.top_left`. */
  readonly name: string;
  /** What the category is expected to be worth, for reporting. Not a filter. */
  readonly focus: 'facade' | 'adjacent' | 'peripheral';
  /** Companies on the national page when FUZZ-4 measured it, for the record. */
  readonly measuredNationalRecords: number;
}

/**
 * Crawl order is by expected facade yield, so a run cut short by `--limit` or
 * the request budget has still covered the categories that matter most.
 */
export const CATEGORIES: readonly Category[] = [
  {
    slug: 'termo-izolacija-zvucna-izolacija',
    name: 'Termo izolacija, zvučna izolacija',
    focus: 'facade',
    measuredNationalRecords: 141,
  },
  {
    slug: 'zavrsni-radovi-restauracije',
    name: 'Završni radovi, restauracije',
    focus: 'facade',
    measuredNationalRecords: 156,
  },
  {
    slug: 'ciscenje-fasada-skidanje-grafita',
    name: 'Čisćenje fasada, skidanje grafita',
    focus: 'facade',
    measuredNationalRecords: 51,
  },
  {
    slug: 'hidroizolacija',
    name: 'Hidroizolacija',
    focus: 'adjacent',
    measuredNationalRecords: 135,
  },
  {
    slug: 'sanacije-gradjevinskih-objekata',
    name: 'Sanacije gradjevinskih objekata',
    focus: 'adjacent',
    measuredNationalRecords: 17,
  },
  {
    slug: 'grubi-gradjevinski-radovi',
    name: 'Grubi gradjevinski radovi',
    focus: 'adjacent',
    measuredNationalRecords: 32,
  },
  {
    slug: 'radovi-na-visini',
    name: 'Radovi na visini',
    focus: 'adjacent',
    measuredNationalRecords: 16,
  },
  {
    slug: 'proizvodnja-stiropora',
    name: 'Proizvodnja stiropora',
    focus: 'adjacent',
    measuredNationalRecords: 26,
  },
  // Machinery, equipment and tools — not facade work. FUZZ-4 counted 94
  // records here, but the page's own heading is "Gradjevinske mašine, oprema i
  // alati za gradjevinske radove", so most of them are plant hire and tool
  // shops. Kept because building-material yards do appear in it; ranked last
  // and marked peripheral so its measured yield decides whether it stays.
  {
    slug: 'za-gradjevinske-radove',
    name: 'Gradjevinske mašine, oprema i alati za gradjevinske radove',
    focus: 'peripheral',
    measuredNationalRecords: 94,
  },
];

const bySlug = new Map(CATEGORIES.map((category) => [category.slug, category]));

export function getCategory(slug: string): Category | undefined {
  return bySlug.get(slug);
}

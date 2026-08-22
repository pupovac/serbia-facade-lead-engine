/**
 * `kompanije-net` — parsing the category index and the company page. Pure
 * functions of the response body; nothing here fetches and nothing here
 * canonicalizes.
 *
 * ## The four traps FUZZ-41 named, and what this file does about them
 *
 * 1. **Anchors use single quotes** — `href='./acalend/26011'`. A regex written
 *    for double quotes matches nothing and reports an empty category. Every
 *    href here is read through cheerio's attribute access, which does not care.
 * 2. **The detail page is a label/value list.** It is *not*, however, a list of
 *    lines: each field is a `div.row-fluid` holding `div.span3` (the label) and
 *    `div.span9.bold` (the value). Reading the pair structurally instead of
 *    reading the line after the label is what makes traps 3 and 4 disappear
 *    rather than need guarding.
 * 3. **Empty fields fall through to the next label** — under a line-based
 *    parse. Under this one a blank field is an empty `div.span9.bold` and reads
 *    as absent. `MATIS NIŠ` has no PIB and is the fixture that proves it. The
 *    guard is kept anyway (`looksLikeLabel`), because it costs one comparison
 *    and the failure it prevents is silent.
 * 4. **`Sajt:` is followed by a prose sentence** — again, only under a
 *    line-based parse: the sentence lives outside the field block entirely.
 *    Here the website is the `Sajt:` row's own value cell, and it is emitted
 *    only when it actually looks like a URL or a host. FUZZ-41 measured 67%
 *    website coverage with the naive reading; the true figure is near zero, and
 *    a website field that is wrong on two records in three would poison
 *    dedup's second-strongest signal.
 *
 * ## Two record layouts, one parser
 *
 * A **privredno društvo** prints `Forma:` and `Status:` and a structured
 * address — `Opština: Beograd-Čukarica | Mesto: Beograd-Čukarica | Ulica i
 * broj: Šavnička 42`. A **preduzetnik** prints neither, and its address is one
 * free-text line. Both are the same `div.row-fluid` list, so the field walk is
 * shared and the address is parsed two ways.
 *
 * The place is recovered from the page's own sentence — "Nalazi se u opštini
 * Obrenovac u mestu Stubline." — when the address is not structured. That
 * sentence is printed for every record on both surfaces and is the only place a
 * sole trader's municipality is stated as a field rather than buried at the end
 * of a street line.
 *
 * ## What is deliberately not read
 *
 * `Status:` is kept in `extra` rather than used to drop a record. The field
 * exists only on the company layout, so filtering on it would silently drop
 * every sole trader — the exact population this source exists to reach. The
 * dead-record question is answered against APR open data downstream, not here.
 */
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { RawLeadInput, ScrapedLink } from '../../types.js';
import type { ActivityCategory, Surface } from './categories.js';

/** `expect` from `CrawlContext`, narrowed to what a parser needs. */
export type Expect = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
) => T;

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/* ------------------------------------------------------------------ *
 * Indexes
 * ------------------------------------------------------------------ */

/** One company link off a category index. */
export interface CategoryEntry {
  /** Absolute detail URL. */
  readonly url: string;
  /** The record id: `26011` on the modern surface, `127306` on the legacy one. */
  readonly recordId: string;
  /** The anchor text — the company's registered name, as the index prints it. */
  readonly name: string;
}

/**
 * The `GRAĐEVINARSTVO` index → `listId → category page URL`.
 *
 * The slug carries diacritics and the site has changed them before
 * (`l76_Ostali-nepomenuti-specifični-…`), so the URL is read here rather than
 * built from a string in `categories.ts`. The stable half is the `l<id>_`
 * prefix, and that is what this matches on.
 */
export function parseSectionIndex($: CheerioAPI, pageUrl: string): Map<string, string> {
  const byListId = new Map<string, string>();
  for (const element of $('a.cat-list[href]').toArray()) {
    const href = $(element).attr('href');
    if (href === undefined) continue;
    const match = /(?:^|\/)(l\d+)_/.exec(href);
    if (match === null) continue;
    const listId = match[1] as string;
    if (!byListId.has(listId)) byListId.set(listId, new URL(href, pageUrl).toString());
  }
  return byListId;
}

/**
 * A modern category page → every company link on it.
 *
 * There is no pagination: `/Srbija/l70_Malterisanje.html` is 138 kB holding all
 * 900 anchors. The caller asserts the result is non-empty, because an empty
 * category page is what a redesign looks like from here.
 */
export function parseModernCategory($: CheerioAPI, pageUrl: string): readonly CategoryEntry[] {
  const entries: CategoryEntry[] = [];
  const seen = new Set<string>();
  for (const element of $('a.cat-list[href]').toArray()) {
    const anchor = $(element);
    const href = anchor.attr('href') as string;
    // `./slug/26011` is a company; `./l70_Malterisanje.html` is a sibling
    // category, and the section index reuses the same class for both.
    const match = /\/(\d+)$/.exec(href);
    if (match === null) continue;
    const url = new URL(href, pageUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, recordId: match[1] as string, name: clean(anchor.text()) ?? '' });
  }
  return entries;
}

/**
 * `./p127306_SOME-NAME.htm` — the legacy index's only distinguishing feature.
 *
 * The slug is the company's registered name *including its street address*, and
 * a Serbian street number is written `PRVOMAJSKA 1/A`, so the slug can contain
 * a slash. Sixty-five of the 852 records in `43.31` do. Anything that treats
 * the slug as one path segment drops them silently.
 */
const LEGACY_HREF = /(?:^|\/)p(\d+)_[^?#]*\.htm$/i;

/**
 * A legacy `preduzetnici.php?delatnost=…` index → every company link on it.
 *
 * The legacy index has no class on its anchors at all, so the shape of the href
 * is the only selector available.
 */
export function parseLegacyCategory($: CheerioAPI, pageUrl: string): readonly CategoryEntry[] {
  const entries: CategoryEntry[] = [];
  const seen = new Set<string>();
  for (const element of $('a[href]').toArray()) {
    const anchor = $(element);
    const href = anchor.attr('href') as string;
    const match = LEGACY_HREF.exec(href);
    if (match === null) continue;
    const url = new URL(href, pageUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, recordId: match[1] as string, name: clean(anchor.text()) ?? '' });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * The detail page
 * ------------------------------------------------------------------ */

/** The labels the template prints. Read verbatim, diacritics included. */
export const LABELS = {
  name: 'Pun naziv:',
  legalForm: 'Forma:',
  status: 'Status:',
  address: 'Adresa:',
  contact: 'Kontakt:',
  phone: 'Telefon:',
  registrationNumber: 'Matični broj:',
  taxId: 'PIB:',
  activityCode: 'Šifra delatnosti:',
  activityName: 'Naziv delatnosti:',
  website: 'Sajt:',
} as const;

/**
 * The labels every record on both surfaces carries.
 *
 * Asserted as a set rather than one at a time, so a template change shows up as
 * "these labels went missing" instead of as one field quietly reading null.
 * `Forma:` and `Status:` are **not** here: a preduzetnik page prints neither,
 * and demanding them would break the run on the majority of the source.
 */
export const REQUIRED_LABELS: readonly string[] = [
  LABELS.name,
  LABELS.address,
  LABELS.phone,
  LABELS.registrationNumber,
  LABELS.taxId,
  LABELS.activityCode,
  LABELS.activityName,
  LABELS.website,
];

/** Trap 3's guard: a value that is itself a label means the row pairing broke. */
function looksLikeLabel(value: string): boolean {
  return value.endsWith(':');
}

/** The structured company address: `Opština: X | Mesto: Y | Ulica i broj: Z`. */
export interface AddressParts {
  readonly municipality: string | null;
  readonly place: string | null;
  readonly street: string | null;
  /** The whole field exactly as printed, for `extra` and for auditing. */
  readonly raw: string;
}

const ADDRESS_KEYS: Readonly<Record<string, keyof Omit<AddressParts, 'raw'>>> = {
  opština: 'municipality',
  opstina: 'municipality',
  mesto: 'place',
  'ulica i broj': 'street',
};

/**
 * Split the address field.
 *
 * Structured on the company layout, one free-text line on the sole-trader
 * layout — `Stubline 372 Stubline`, street and place run together with nothing
 * between them. There is no rule that separates those two reliably, so the
 * free-text case keeps the whole line as the street and lets the place come
 * from the page's own sentence instead of guessing at a split.
 */
export function parseAddress(raw: string): AddressParts {
  const parts: { municipality: string | null; place: string | null; street: string | null } = {
    municipality: null,
    place: null,
    street: null,
  };
  let structured = false;
  for (const segment of raw.split('|')) {
    const separator = segment.indexOf(':');
    if (separator === -1) continue;
    const key = segment.slice(0, separator).trim().toLowerCase();
    const field = ADDRESS_KEYS[key];
    if (field === undefined) continue;
    structured = true;
    parts[field] = clean(segment.slice(separator + 1));
  }
  if (!structured) parts.street = clean(raw);
  return { ...parts, raw };
}

/**
 * `Nalazi se u opštini Obrenovac u mestu Stubline.`
 *
 * The sentence is printed under the field block for every record on both
 * surfaces, and on the sole-trader layout it is the only statement of the
 * municipality that is not glued to the end of a street line.
 */
const PLACE_SENTENCE = /u\s+opštini\s+(.+?)\s+u\s+mestu\s+(.+?)\s*\./iu;

export function parsePlaceSentence(text: string): {
  municipality: string | null;
  place: string | null;
} {
  const match = PLACE_SENTENCE.exec(text);
  if (match === null) return { municipality: null, place: null };
  return { municipality: clean(match[1]), place: clean(match[2]) };
}

/**
 * Is this `Sajt:` value actually a website?
 *
 * Trap 4, made explicit. The field is empty on almost every record, and the
 * cost of being wrong is a bogus domain on a lead — dedup's second-strongest
 * signal — so the bar is a scheme or something with a dot and no spaces.
 */
export function looksLikeWebsite(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#].*)?$/i.test(value);
}

/**
 * Phones as the field prints them: `+381.(0)64.4320025`, comma-separated when
 * a record has more than one, with a trailing comma on some.
 *
 * Splitting on the comma is parsing, not normalization — `src/lib/phone`
 * rejects the joined string outright and reads either half perfectly, `.(0)`
 * shim included. Nothing else is touched: the raw string is what reaches
 * `RawLead.phones`.
 */
export function splitPhones(value: string): readonly string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The place string the record publishes, as one value.
 *
 * A sole trader's `Mesto` is very often a village — `Stubline`, `Milutinovac`
 * — and no gazetteer resolves a village on its own. The page states the
 * opština in the same sentence, and `Mesto, Opština` is the shape
 * `src/lib/normalize` already reads (`Beograd, Vračar`), so the two published
 * fields are handed over together rather than one of them being thrown away.
 * Resolving them is still `src/lib`'s job and is not done here.
 */
export function placeString(place: string | null, municipality: string | null): string | null {
  if (place === null) return municipality;
  if (municipality === null || municipality === place) return place;
  return `${place}, ${municipality}`;
}

/** One company page, field by field, exactly as printed. */
export interface CompanyPage {
  readonly name: string;
  readonly legalForm: string | null;
  /** `Aktivno privredno društvo`. Company layout only; never used as a filter. */
  readonly status: string | null;
  readonly address: AddressParts | null;
  /** `Opština` from the address field, else from the page's own sentence. */
  readonly municipality: string | null;
  /** `Mesto` from the address field, else from the page's own sentence. */
  readonly place: string | null;
  /** The named contact person, when the record has one. */
  readonly contactPerson: string | null;
  readonly phones: readonly string[];
  readonly registrationNumber: string | null;
  readonly taxId: string | null;
  /** `4331`. The state's own classification of the business. */
  readonly activityCode: string | null;
  readonly activityName: string | null;
  /** Only when the value survives `looksLikeWebsite`. Near-always null. */
  readonly website: string | null;
  /**
   * The `Sajt:` cell exactly as printed, accepted or not.
   *
   * Kept so trap 4 stays auditable: "this record published nothing", "this
   * record published something that is not a URL" and "this parser did not
   * look" are three different facts and only the raw value separates them.
   */
  readonly websiteRaw: string | null;
  /** Owners and their shares, printed under `Članovi` on the company layout. */
  readonly members: readonly string[];
  /** Visible text of the record block plus the page's own sentence about it. */
  readonly text: string;
  /** Anchors inside the record block. The site's own chrome is not in here. */
  readonly links: readonly ScrapedLink[];
  /** Every label the page printed, for the structural assertion and for auditing. */
  readonly labels: readonly string[];
}

/** The row list: `div.row-fluid` holding `div.span3` label + `div.span9` value. */
function readFields(
  $: CheerioAPI,
  block: ReturnType<CheerioAPI>,
): {
  fields: Map<string, string[]>;
  labels: string[];
} {
  const fields = new Map<string, string[]>();
  const labels: string[] = [];
  for (const element of block.find('div.row-fluid').toArray()) {
    const row = $(element);
    const label = clean(row.children('div.span3').first().text());
    if (label === null) continue;
    labels.push(label);
    const value = clean(row.children('div.span9').first().text());
    if (value === null || looksLikeLabel(value)) continue;
    const existing = fields.get(label);
    if (existing === undefined) fields.set(label, [value]);
    else existing.push(value);
  }
  return { fields, labels };
}

/** Anchors inside a block, resolved against the page. `mailto:`/`tel:` left alone. */
function linksIn(
  $: CheerioAPI,
  scope: ReturnType<CheerioAPI>,
  pageUrl: string,
): readonly ScrapedLink[] {
  const links = new Map<string, ScrapedLink>();
  for (const element of scope.find('a[href]').toArray() as Element[]) {
    const anchor = $(element);
    const href = anchor.attr('href') ?? '';
    if (href === '' || href.startsWith('#')) continue;
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : new URL(href, pageUrl).toString();
    const text = clean(anchor.text());
    const rel = anchor.attr('rel');
    const key = `${absolute} ${text ?? ''}`;
    if (links.has(key)) continue;
    links.set(key, {
      href: absolute,
      ...(text === null ? {} : { text }),
      ...(rel === undefined || rel === '' ? {} : { rel }),
    });
  }
  return [...links.values()];
}

/**
 * The visible text of a block, with the page's advertising taken out.
 *
 * `cheerio`'s `.text()` walks into `<script>`, and the field block on this site
 * has an AdSense unit inside it, so the record's own words otherwise arrive
 * with `(adsbygoogle = window.adsbygoogle || []).push({});` glued to the end.
 * That string is not evidence about a company and it must not reach the
 * classifier or `raw_records` as if it were.
 */
function visibleText(scope: ReturnType<CheerioAPI>): string | null {
  const copy = scope.clone();
  copy.find('script, style, ins, noscript, iframe').remove();
  return clean(copy.text());
}

/**
 * Parse one company page, modern or legacy — the markup is identical.
 *
 * Three assertions, all on things the template prints for every record on both
 * surfaces: the field block, the full name, and the label set. The label
 * assertion is the one that earns its keep: a template that renames `Telefon:`
 * would otherwise produce a healthy run of records with no phone, which is this
 * source's entire value silently going to zero.
 */
export function parseCompany($: CheerioAPI, url: string, expect: Expect): CompanyPage {
  const blocks = $('#data_content div.border.well');
  const block = expect(
    blocks.length === 0 ? null : blocks.first(),
    '#data_content div.border.well',
    url,
    'the company field block',
  );

  const { fields, labels } = readFields($, block);
  const first = (label: string): string | null => fields.get(label)?.[0] ?? null;

  const missing = REQUIRED_LABELS.filter((label) => !labels.includes(label));
  if (missing.length > 0) {
    expect(
      null,
      `labels ${missing.join(', ')}`,
      url,
      `the field labels ${REQUIRED_LABELS.join(', ')}`,
    );
  }

  const name = expect(first(LABELS.name), `${LABELS.name} value`, url, "the company's full name");

  const addressRaw = first(LABELS.address);
  const address = addressRaw === null ? null : parseAddress(addressRaw);

  // The sentence sits in the sibling `div.span12`, outside the field block.
  const sentence = visibleText($('#data_content > div.span12').first()) ?? '';
  const fromSentence = parsePlaceSentence(sentence);

  const websiteRaw = first(LABELS.website);
  const website = websiteRaw !== null && looksLikeWebsite(websiteRaw) ? websiteRaw : null;

  const members: string[] = [];
  for (const element of $('#data_content h4').toArray()) {
    if (clean($(element).text()) !== 'Članovi') continue;
    for (const row of $(element).parent().find('div.row-fluid').toArray()) {
      const value = clean($(row).children('div.span9').first().text());
      if (value !== null && !looksLikeLabel(value)) members.push(value);
    }
  }

  const phoneRaw = first(LABELS.phone);

  return {
    name,
    legalForm: first(LABELS.legalForm),
    status: first(LABELS.status),
    address,
    municipality: address?.municipality ?? fromSentence.municipality,
    place: address?.place ?? fromSentence.place,
    contactPerson: first(LABELS.contact),
    phones: phoneRaw === null ? [] : splitPhones(phoneRaw),
    registrationNumber: first(LABELS.registrationNumber),
    taxId: first(LABELS.taxId),
    activityCode: first(LABELS.activityCode),
    activityName: first(LABELS.activityName),
    website,
    websiteRaw,
    members,
    text: [visibleText(block), sentence]
      .filter((part): part is string => part !== null && part !== '')
      .join('\n'),
    links: linksIn($, block, url),
    labels,
  };
}

/* ------------------------------------------------------------------ *
 * RawLead
 * ------------------------------------------------------------------ */

export interface RecordRef {
  readonly recordId: string;
  readonly surface: Surface;
  readonly category: ActivityCategory;
}

/**
 * Turn a parsed page into the record the adapter emits.
 *
 * Two decisions worth stating.
 *
 * **`assertedType` is claimed, and only for the core codes.** Being in
 * `43.31 Malterisanje` *is* the evidence — the classifier has nothing to read
 * on a page whose only prose is "Ova firma se bavi pretežno delatnošću
 * Malterisanje", and a sole trader called `ACA LAZAREVIĆ PR` scores `UNKNOWN`
 * forever otherwise. `assertedTypeReason` names the code and the site's own
 * category label, so the claim stays arguable from the `sourceUrl`. An adjacent
 * code asserts nothing: `41.20 Izgradnja zgrada` is general construction, and
 * claiming a facade contractor there would be the assertion doing the
 * classifier's guessing for it.
 *
 * **No email is ever emitted.** The template has no email field at all. That is
 * fine and expected — a name, a city and a phone is a good lead.
 */
export function toRawLead(page: CompanyPage, url: string, ref: RecordRef): RawLeadInput {
  const asserted = ref.category.tier === 'core';
  return {
    sourceUrl: url,
    name: page.name,
    ...(page.legalForm === null ? {} : { legalForm: page.legalForm }),
    ...(page.registrationNumber === null ? {} : { registrationNumber: page.registrationNumber }),
    ...(page.taxId === null ? {} : { taxId: page.taxId }),
    phones: [...page.phones],
    emails: [],
    ...(page.website === null ? {} : { website: page.website }),
    ...((): { city?: string } => {
      const city = placeString(page.place, page.municipality);
      return city === null ? {} : { city };
    })(),
    ...(page.address?.street === null || page.address === null
      ? {}
      : { address: page.address.street }),
    categories: [
      ...new Set(
        [page.activityName, ref.category.name].filter((value): value is string => value !== null),
      ),
    ],
    ...(asserted
      ? {
          assertedType: 'FACADE_CONTRACTOR' as const,
          assertedTypeReason:
            `registered under KD ${ref.category.code} ${ref.category.name} ` +
            `(šifra delatnosti ${page.activityCode ?? ref.category.sifra})`,
        }
      : {}),
    text: page.text,
    links: [...page.links],
    extra: {
      recordId: ref.recordId,
      surface: ref.surface,
      categoryCode: ref.category.code,
      categoryListId: ref.category.listId,
      ...(page.activityCode === null ? {} : { sifraDelatnosti: page.activityCode }),
      ...(page.status === null ? {} : { status: page.status }),
      ...(page.municipality === null ? {} : { municipality: page.municipality }),
      ...(page.address === null ? {} : { addressRaw: page.address.raw }),
      ...(page.contactPerson === null ? {} : { contactPerson: page.contactPerson }),
      ...(page.members.length === 0 ? {} : { members: page.members }),
      // Recorded even when empty, so "this record published no website" and
      // "this parser did not look" stay distinguishable in `raw_records`.
      websiteFieldRaw: page.websiteRaw,
    },
  };
}

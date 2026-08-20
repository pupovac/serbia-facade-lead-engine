/**
 * `gradjevinarstvo-rs` — parsing a company page. Pure functions of the body.
 *
 * Nothing here fetches, and nothing here canonicalizes: `034 364 282` and
 * `011 2641 564, BEOGRAD` come out exactly as the page printed them, ALL-CAPS
 * company names included. `src/lib` owns normalization and
 * `src/scraper/pipeline.ts` is what calls it.
 *
 * ## The contact card is a flat list of pairs, not a table
 *
 * The card is one `div.col-md-12.left` holding a place line, a street line,
 * and then a run of `col-md-1` / `col-md-11` div pairs. The narrow half holds
 * a Font Awesome icon that names the field; the wide half holds the value:
 *
 * ```html
 * <div class="col-md-1 …"><i class="fa fa-align-left fa-phone"></i></div>
 * <div class="col-md-11 …">031 3868 000</div>
 * <div class="col-md-1 …"></div>            <!-- no icon: still a phone -->
 * <div class="col-md-11 …">031 3100 108</div>
 * ```
 *
 * An **empty** narrow half means "same field as the row above", which is how a
 * company lists four numbers. So the walk is stateful: an icon sets the current
 * field, an empty cell keeps it, and every wide cell appends to whatever the
 * current field is. Reading the pairs independently would keep only the first
 * number of every company that has more than one — a quiet 40% phone loss on
 * exactly the records worth having.
 *
 * An icon this parser does not recognise is kept under `other`, with its icon
 * name, rather than dropped. A source that adds a field should show up in the
 * data as an unread field, not as nothing.
 *
 * ## Two category layouts, one selector
 *
 * A plain company page prints its categories under an `h4` reading
 * "Kategorije za NAME"; a company with a paid presentation prints the same list
 * in a sidebar headed "KATEGORIJE". Rather than special-case the two headings,
 * both are reached through the anchor the template gives category links and
 * gives nothing else: `a[role=link].color-gray.padding-5[href^="/kategorije/"]`.
 * The site navigation and the footer link `/kategorije/…` too, and neither
 * carries those classes.
 *
 * The free-text line under a category is worth as much as the category itself.
 * `POPOVIĆ` is filed under generic construction categories, and the only thing
 * on the page that identifies it as a facade contractor is the note
 * "Specijalizovana ekipa za izvođenje fasaderskih radova (izrada
 * termoizolacionih fasada od stiropora po sistemu Demit)".
 */
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { RawLeadInput, ScrapedLink } from '../../types.js';
import type { FirmRef } from './sitemap.js';

/** `expect` from `CrawlContext`, narrowed to what a parser needs. */
export type Expect = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
) => T;

/** The contact card, field by field, exactly as printed. */
export interface FirmContact {
  /** The card repeats the company name in bold on a presented page. */
  readonly displayName: string | null;
  /** `34000` from `34000 KRAGUJEVAC, SRB`. */
  readonly postalCode: string | null;
  /** `KRAGUJEVAC`. Resolved to a municipality downstream, never here. */
  readonly city: string | null;
  /**
   * `SRB`, `BIH`, `HRV`, … The register is regional, not Serbian, and this is
   * the field that says so — see `index.ts` for what is done about it.
   */
  readonly country: string | null;
  readonly address: string | null;
  /** As printed: `034 364 282`, `011 2641 564, BEOGRAD`. */
  readonly phones: readonly string[];
  /** Kept apart from `phones`: a fax is not a number to call a fasader on. */
  readonly faxes: readonly string[];
  readonly contactPerson: string | null;
  readonly website: string | null;
  readonly emails: readonly string[];
  /** Anything behind an icon this parser does not know, as `icon → values`. */
  readonly other: Readonly<Record<string, readonly string[]>>;
}

export interface FirmPage {
  /** `h1.naslov-firme-boja`, as published — ALL CAPS on most of the register. */
  readonly name: string;
  readonly contact: FirmContact;
  /** Category names, parents and leaves alike, in page order. */
  readonly categories: readonly string[];
  /** `/kategorije/{id}/{slug}` paths, for `extra` and for later re-selection. */
  readonly categoryPaths: readonly string[];
  /** The free-text line a company writes under one of its categories. */
  readonly categoryNotes: readonly string[];
  /** The company's own presentation paragraph, when it has paid for one. */
  readonly description: string | null;
  /** Visible text of the record blocks only. Never the whole page. */
  readonly text: string;
  /** Anchors inside the record blocks only, so the portal's own links stay out. */
  readonly links: readonly ScrapedLink[];
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/** `34000 KRAGUJEVAC, SRB` — postal, place, ISO-ish country, all optional. */
const PLACE = /^(?:(\d{4,6})\s+)?(.+?)(?:\s*,\s*([A-ZČĆŽŠĐ]{2,4}))?$/u;

interface Place {
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly country: string | null;
}

/**
 * Split the place line.
 *
 * Exported because it is the one piece of this file with a rule worth pinning
 * down on its own: the country suffix is what keeps a Bosnian municipality out
 * of a Serbia-only database, and `VALJEVO-BELOŠEVAC` has to survive it intact.
 */
export function parsePlace(line: string | null): Place {
  const value = clean(line);
  if (value === null) return { postalCode: null, city: null, country: null };
  const match = PLACE.exec(value);
  if (match === null) return { postalCode: null, city: value, country: null };
  return {
    postalCode: match[1] ?? null,
    city: clean(match[2]),
    country: match[3] ?? null,
  };
}

/** Does this line look like the place line rather than the street line? */
function looksLikePlace(line: string): boolean {
  return /^\d{4,6}\s/.test(line) || /,\s*[A-ZČĆŽŠĐ]{2,4}$/u.test(line);
}

/** Which contact field an icon class names. `null` means "we do not read this one". */
function fieldOfIcon(iconClass: string): string | null {
  if (/\bfa-phone\b/.test(iconClass)) return 'phone';
  if (/\bfa-fax\b/.test(iconClass)) return 'fax';
  if (/\bfa-smile\b/.test(iconClass)) return 'person';
  if (/\bfa-home\b/.test(iconClass)) return 'website';
  if (/\bfa-(envelope|at)\b/.test(iconClass)) return 'email';
  // A named icon we do not model. Keep its own name so `other` says what it was.
  const named = /\bfa-([a-z0-9-]+)\b/.exec(iconClass.replace(/\bfa-align-[a-z]+\b/g, ''));
  return named === null ? null : `icon:${named[1] as string}`;
}

/**
 * Read the contact card.
 *
 * `block` is `div.col-md-12.left` — asserted by the caller, because its absence
 * is a redesign rather than a company without a phone.
 */
export function parseContact($: CheerioAPI, block: Cheerio<Element>): FirmContact {
  let displayName: string | null = null;
  const lines: string[] = [];

  const phones: string[] = [];
  const faxes: string[] = [];
  const emails: string[] = [];
  const persons: string[] = [];
  const websites: string[] = [];
  const other: Record<string, string[]> = {};

  // The current field, carried across rows: an empty narrow cell means the
  // wide cell beside it belongs to whatever the last icon named.
  let field: string | null = null;

  for (const element of block.children().toArray()) {
    const cell = $(element);
    const classes = cell.attr('class') ?? '';

    if (/\bcol-md-1\b/.test(classes)) {
      const icon = cell.find('i').attr('class') ?? '';
      if (icon !== '') field = fieldOfIcon(icon);
      continue;
    }

    if (/\bcol-md-11\b/.test(classes)) {
      if (field === 'website') {
        const href = cell.find('a[href]').attr('href');
        const value = clean(href) ?? clean(cell.text());
        if (value !== null) websites.push(value);
        continue;
      }
      const value = clean(cell.text());
      if (value === null) continue;
      switch (field) {
        case 'phone':
          phones.push(value);
          break;
        case 'fax':
          faxes.push(value);
          break;
        case 'email':
          emails.push(value);
          break;
        case 'person':
          persons.push(value);
          break;
        default: {
          const key = field ?? 'unlabelled';
          (other[key] ??= []).push(value);
        }
      }
      continue;
    }

    if (/\bcol-md-12\b/.test(classes)) {
      const value = clean(cell.text());
      if (value === null) continue;
      // The bold repeat of the company name, present only on presented pages.
      if (/\bbold\b/.test(classes) && displayName === null) displayName = value;
      else lines.push(value);
    }
  }

  const placeIndex = lines.findIndex(looksLikePlace);
  const placeLine = placeIndex === -1 ? (lines[0] ?? null) : (lines[placeIndex] as string);
  const addressLine = placeIndex === -1 ? (lines[1] ?? null) : (lines[placeIndex + 1] ?? null);
  const place = parsePlace(placeLine);

  return {
    displayName,
    postalCode: place.postalCode,
    city: place.city,
    country: place.country,
    address: clean(addressLine),
    phones,
    faxes,
    contactPerson: persons[0] ?? null,
    website: websites[0] ?? null,
    emails,
    other,
  };
}

/** Anchors inside a block, resolved against the page. `mailto:`/`tel:` are left alone. */
function linksIn(
  $: CheerioAPI,
  scope: Cheerio<Element>,
  pageUrl: string,
  into: Map<string, ScrapedLink>,
): void {
  for (const element of scope.find('a[href]').toArray()) {
    const anchor = $(element);
    const href = anchor.attr('href') ?? '';
    if (href === '' || href.startsWith('#')) continue;
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : new URL(href, pageUrl).toString();
    const text = clean(anchor.text());
    const rel = anchor.attr('rel');
    const key = `${absolute} ${text ?? ''}`;
    if (into.has(key)) continue;
    into.set(key, {
      href: absolute,
      ...(text === null ? {} : { text }),
      ...(rel === undefined || rel === '' ? {} : { rel }),
    });
  }
}

/** Category links, and only the ones the record block owns. */
const CATEGORY_LINK = 'a[role="link"].color-gray.padding-5[href^="/kategorije/"]';

/** The presentation paragraph. `<p>` cannot nest, so the text lands beside it. */
function descriptionOf($: CheerioAPI): string | null {
  const paragraph = $('p.font12px.font-normal.line-height-20').first();
  if (paragraph.length === 0) return null;
  return clean(paragraph.parent().text());
}

/**
 * Parse one `/firme/{id}/{slug}` page.
 *
 * Two assertions, both on things the template prints for every company: the
 * heading and the contact card. A page missing either is a redesign, and the
 * run must stop rather than report a healthy crawl of companies with no name.
 */
export function parseFirm($: CheerioAPI, url: string, expect: Expect): FirmPage {
  const name = expect(clean($('h1.naslov-firme-boja').first().text()), 'h1.naslov-firme-boja', url);

  const cards = $('div.col-md-12.left');
  const card = expect(
    cards.length === 0 ? null : cards.first(),
    'div.col-md-12.left',
    url,
    'the contact card',
  );
  const contact = parseContact($, card);

  const categories: string[] = [];
  const categoryPaths: string[] = [];
  for (const element of $(CATEGORY_LINK).toArray()) {
    const anchor = $(element);
    const label = clean(anchor.text());
    const href = anchor.attr('href');
    if (label === null) continue;
    categories.push(label);
    if (href !== undefined) categoryPaths.push(href);
  }

  // The note is the sibling `span` of the arrow glyph the template puts in
  // front of it, which is what keeps it apart from the `/P` and `/U` markers.
  const categoryNotes: string[] = [];
  for (const element of $('span.glyphicon-circle-arrow-right').toArray()) {
    const note = clean($(element).next('span').text());
    if (note !== null) categoryNotes.push(note);
  }

  const description = descriptionOf($);

  const links = new Map<string, ScrapedLink>();
  linksIn($, card, url, links);
  const presentation = $('p.font12px.font-normal.line-height-20').first().parent();
  if (presentation.length > 0) linksIn($, presentation, url, links);

  // Only what the record itself published. The portal's own footer carries
  // facebook.com/gradjevinarstvo, and it must never reach a lead's socials.
  const text = [clean(card.text()), description, ...categories, ...categoryNotes]
    .filter((part): part is string => part !== null)
    .join('\n');

  return {
    name,
    contact,
    categories,
    categoryPaths,
    categoryNotes,
    description,
    text,
    links: [...links.values()],
  };
}

/**
 * Turn a parsed page into the record the adapter emits.
 *
 * The company's note under a category is folded into `description` rather than
 * into `categories`: it is prose the company wrote about itself, and it is
 * often the only sentence on the page that says what the company actually does.
 */
export function toRawLead(page: FirmPage, url: string, ref: FirmRef): RawLeadInput {
  const { contact } = page;
  const description = [page.description, ...page.categoryNotes]
    .filter((part): part is string => part !== null && part !== '')
    .join('\n');

  return {
    sourceUrl: url,
    name: page.name,
    phones: [...contact.phones],
    emails: [...contact.emails],
    ...(contact.website === null ? {} : { website: contact.website }),
    ...(contact.city === null ? {} : { city: contact.city }),
    ...(contact.address === null ? {} : { address: contact.address }),
    ...(contact.postalCode === null ? {} : { postalCode: contact.postalCode }),
    categories: [...page.categories],
    ...(description === '' ? {} : { description }),
    text: page.text,
    links: [...page.links],
    extra: {
      firmId: ref.id,
      slug: ref.slug,
      country: contact.country,
      ...(contact.faxes.length === 0 ? {} : { faxes: contact.faxes }),
      ...(contact.contactPerson === null ? {} : { contactPerson: contact.contactPerson }),
      ...(contact.displayName === null ? {} : { displayName: contact.displayName }),
      ...(page.categoryPaths.length === 0 ? {} : { categoryPaths: page.categoryPaths }),
      ...(Object.keys(contact.other).length === 0 ? {} : { unreadFields: contact.other }),
    },
  };
}

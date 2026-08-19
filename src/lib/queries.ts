/**
 * The Serbian search-query generator.
 *
 * Discovery runs do not carry a hard-coded list of search strings. They carry a
 * term inventory (`data/query-templates.json`) and the geographic dataset
 * (`data/serbia-geo.json`), and this module composes the two. Adding one city
 * or one term multiplies across the whole search space without anyone editing a
 * list of strings.
 *
 * Three things every generated query has to get right:
 *
 * 1. **Both spellings.** Serbian pages are written either with diacritics
 *    (`građevinski`) or ASCII-folded (`gradjevinski`), and each spelling finds
 *    pages the other misses. Every query is emitted in both — folded whole, so
 *    a query is never half one spelling and half the other.
 * 2. **Inflection.** Serbian listings say "fasader u Novom Sadu", not "fasader
 *    Novi Sad". The place forms come from `search_variants`, which carries the
 *    nominative, locative and genitive.
 * 3. **Deduplication.** `Novi Sad` folds to itself, so its diacritic and ASCII
 *    queries are identical. Emitting both would double the request count for
 *    nothing.
 *
 * Cyrillic output is supported behind `scripts: ['cyrillic']` and is off by
 * default — see `research/2026-08-19-fuzz-7-query-library.md` for the measured
 * reason why.
 */
import templateData from '../../data/query-templates.json' with { type: 'json' };
import {
  findMunicipalityByName,
  getMunicipalityById,
  municipalitiesInTier,
  type Municipality,
} from './geo.js';
import { foldDiacritics, normalizeWhitespace } from './text/fold.js';
import { toCyrillic } from './text/cyrillic.js';

export type LeadType = 'FACADE_CONTRACTOR' | 'CONSTRUCTION_MATERIAL_STORE';

/**
 * How much of what a term returns is actually the business we want.
 *
 * `narrow` — almost every hit is on target (`demit fasada`).
 * `medium` — mostly on target with a predictable adjacent trade mixed in.
 * `broad` — target businesses are a minority (`termoizolacija` also returns
 * window, roof and floor insulators).
 */
export type Precision = 'narrow' | 'medium' | 'broad';

/**
 * How wide to cast. `narrow` is the cheap high-precision probe, `core` is the
 * default working set, `all` is the exhaustive sweep for a municipality that
 * came back thin.
 */
export type QueryVariant = 'narrow' | 'core' | 'all';

export type QueryScript = 'latin' | 'cyrillic';

/** How the place name is attached to the term. `none` is a place-less query. */
export type PlacePattern = 'nominative' | 'locative' | 'locative_prep' | 'genitive' | 'none';

export interface QueryTemplate {
  /** Stable ASCII-folded slug, e.g. `demit-fasada`. */
  readonly id: string;
  /** Nominative Serbian Latin, diacritics intact. The other spellings are derived. */
  readonly term: string;
  readonly lead_types: readonly LeadType[];
  readonly precision: Precision;
  /**
   * A string overrides the automatic transliteration; `false` suppresses
   * Cyrillic output entirely, for terms built on a Latin brand or acronym
   * (`Baumit distributer`, `EPS ploče`).
   */
  readonly term_cyrillic?: string | false;
  /** Why this precision, or what the term drags in with it. */
  readonly note?: string;
}

/** One generated query with the provenance a run needs to score what it returned. */
export interface SearchQuery {
  readonly query: string;
  readonly template_id: string;
  /** Which of the requested lead types this term targets — one or both. */
  readonly lead_types: readonly LeadType[];
  readonly precision: Precision;
  readonly script: QueryScript;
  /** `null` for a place-less, nationwide query. */
  readonly municipality_id: string | null;
  readonly pattern: PlacePattern;
  /** True when this is the ASCII-folded spelling of a diacritic query. */
  readonly folded: boolean;
}

export interface GenerateQueriesOptions {
  readonly leadType: LeadType | readonly LeadType[];
  /**
   * Municipality slug id, or any spelling the geographic dataset knows —
   * `novi-sad`, `Novi Sad`, `Novom Sadu`, `Нови Сад`. Omit for place-less
   * queries. Unknown names throw rather than silently widening the search.
   */
  readonly municipality?: string | readonly string[];
  /** Default `core`. */
  readonly variant?: QueryVariant;
  /** Default `['latin']`. */
  readonly scripts?: readonly QueryScript[];
  /** Override the term inventory. Used by tests; production reads the JSON. */
  readonly templates?: readonly QueryTemplate[];
}

interface VariantRule {
  readonly precisions: readonly Precision[];
  readonly patterns: readonly Exclude<PlacePattern, 'none'>[];
}

const VARIANT_RULES: Readonly<Record<QueryVariant, VariantRule>> = {
  narrow: {
    precisions: ['narrow'],
    patterns: ['nominative'],
  },
  core: {
    precisions: ['narrow', 'medium'],
    patterns: ['nominative', 'locative_prep'],
  },
  all: {
    precisions: ['narrow', 'medium', 'broad'],
    patterns: ['nominative', 'locative', 'locative_prep', 'genitive'],
  },
};

/** Emission order, so a truncated run has spent its requests on the best terms. */
const PRECISION_RANK: Readonly<Record<Precision, number>> = { narrow: 0, medium: 1, broad: 2 };

const PREPOSITIONS = templateData.locative_prepositions;

/** The curated term inventory, in file order within each precision. */
export const queryTemplates: readonly QueryTemplate[] =
  templateData.templates as readonly QueryTemplate[];

/** Provenance and the precision definitions the inventory was curated under. */
export const queryTemplateMeta = templateData._meta;

/**
 * The templates targeting a lead type, ordered narrow → medium → broad.
 *
 * `variant` filters by precision the same way `generateQueries` does; omit it
 * to get every template for the lead type.
 */
export function templatesFor(
  leadType: LeadType | readonly LeadType[],
  variant?: QueryVariant,
  templates: readonly QueryTemplate[] = queryTemplates,
): readonly QueryTemplate[] {
  const wanted = new Set(typeof leadType === 'string' ? [leadType] : leadType);
  const precisions = variant ? new Set(VARIANT_RULES[variant].precisions) : null;
  return templates
    .filter(
      (t) =>
        t.lead_types.some((lt) => wanted.has(lt)) &&
        (precisions === null || precisions.has(t.precision)),
    )
    .sort((a, b) => PRECISION_RANK[a.precision] - PRECISION_RANK[b.precision]);
}

/**
 * Generate the deduplicated query strings for a lead type and a place.
 *
 * ```ts
 * generateQueries({ leadType: 'FACADE_CONTRACTOR', municipality: 'novi-sad', variant: 'all' })
 * // → ["fasader Novi Sad", "fasader Novom Sadu", "fasader u Novom Sadu", ...]
 * ```
 *
 * Pure and deterministic: same options in, same array out, in the same order.
 */
export function generateQueries(options: GenerateQueriesOptions): readonly string[] {
  return generateQueryPlan(options).map((q) => q.query);
}

/**
 * The same query set as `generateQueries`, with the provenance of each string.
 *
 * Ordered municipality by municipality, and inside a municipality narrow terms
 * first — a run cut short after N requests has spent them on the best terms of
 * the best cities.
 */
export function generateQueryPlan(options: GenerateQueriesOptions): readonly SearchQuery[] {
  const leadTypes = typeof options.leadType === 'string' ? [options.leadType] : options.leadType;
  const variant = options.variant ?? 'core';
  const scripts = options.scripts ?? (['latin'] as const);
  const rule = VARIANT_RULES[variant];
  const templates = templatesFor(leadTypes, variant, options.templates ?? queryTemplates);
  const places = resolveMunicipalities(options.municipality);

  const seen = new Set<string>();
  const plan: SearchQuery[] = [];

  const emit = (
    query: string,
    template: QueryTemplate,
    script: QueryScript,
    pattern: PlacePattern,
    municipalityId: string | null,
    folded: boolean,
  ): void => {
    const normalized = normalizeWhitespace(query);
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    plan.push({
      query: normalized,
      template_id: template.id,
      lead_types: template.lead_types.filter((lt) => leadTypes.includes(lt)),
      precision: template.precision,
      script,
      municipality_id: municipalityId,
      pattern,
      folded,
    });
  };

  // A diacritic query and its ASCII fold are the same query in two spellings —
  // fold the whole string so a query is never half one spelling, half the other.
  const emitLatin = (
    query: string,
    template: QueryTemplate,
    pattern: PlacePattern,
    municipalityId: string | null,
  ): void => {
    emit(query, template, 'latin', pattern, municipalityId, false);
    const asciiFolded = foldDiacritics(query);
    if (asciiFolded !== query) emit(asciiFolded, template, 'latin', pattern, municipalityId, true);
  };

  const wantLatin = scripts.includes('latin');
  const wantCyrillic = scripts.includes('cyrillic');

  if (places.length === 0) {
    for (const template of templates) {
      if (wantLatin) emitLatin(template.term, template, 'none', null);
      if (wantCyrillic) {
        const cyrillic = cyrillicTerm(template);
        if (cyrillic !== null) emit(cyrillic, template, 'cyrillic', 'none', null, false);
      }
    }
    return plan;
  }

  for (const place of places) {
    const latin = latinCaseForms(place);
    const cyrillic = cyrillicCaseForms(place);
    const preposition = locativePreposition(place.id);
    for (const template of templates) {
      for (const pattern of rule.patterns) {
        if (wantLatin) {
          emitLatin(
            compose(template.term, latin, pattern, preposition),
            template,
            pattern,
            place.id,
          );
        }
        if (wantCyrillic) {
          const term = cyrillicTerm(template);
          if (term !== null) {
            const query = compose(term, cyrillic, pattern, toCyrillic(preposition));
            emit(query, template, 'cyrillic', pattern, place.id, false);
          }
        }
      }
    }
  }

  return plan;
}

/**
 * The full deduplicated query set for a priority tier — what a tier-1 sweep
 * actually costs in requests.
 */
export function generateTierQueries(
  tier: 1 | 2 | 3,
  options: Omit<GenerateQueriesOptions, 'municipality'>,
): readonly SearchQuery[] {
  return generateQueryPlan({
    ...options,
    municipality: municipalitiesInTier(tier).map((m) => m.id),
  });
}

/** Template counts by lead type and precision — the inventory at a glance. */
export function termInventoryCounts(templates: readonly QueryTemplate[] = queryTemplates): {
  total: number;
  byLeadType: Record<LeadType, number>;
  byPrecision: Record<Precision, number>;
} {
  const byLeadType: Record<LeadType, number> = {
    FACADE_CONTRACTOR: 0,
    CONSTRUCTION_MATERIAL_STORE: 0,
  };
  const byPrecision: Record<Precision, number> = { narrow: 0, medium: 0, broad: 0 };
  for (const template of templates) {
    for (const leadType of template.lead_types) byLeadType[leadType] += 1;
    byPrecision[template.precision] += 1;
  }
  return { total: templates.length, byLeadType, byPrecision };
}

/**
 * The preposition a municipality takes in the locative: `u` for almost
 * everywhere, `na` for most Belgrade city municipalities ("na Vračaru").
 */
export function locativePreposition(municipalityId: string): string {
  const overrides: Readonly<Record<string, string>> = PREPOSITIONS.overrides;
  return overrides[municipalityId] ?? PREPOSITIONS.default;
}

function compose(
  term: string,
  forms: CaseForms,
  pattern: PlacePattern,
  preposition: string,
): string {
  switch (pattern) {
    case 'nominative':
      return `${term} ${forms.nominative}`;
    case 'locative':
      return `${term} ${forms.locative}`;
    case 'locative_prep':
      return `${term} ${preposition} ${forms.locative}`;
    case 'genitive':
      return `${term} ${forms.genitive}`;
    case 'none':
      return term;
  }
}

interface CaseForms {
  readonly nominative: string;
  readonly locative: string;
  readonly genitive: string;
}

/**
 * The Latin nominative, locative and genitive of a place name, diacritics
 * intact.
 *
 * `search_variants` is a flat list that interleaves spellings with cases —
 * `["Čačak", "Cacak", "Čačku", "Cacku", "Čačka", "Cacka"]`. Grouping adjacent
 * entries by their fold recovers the three cases; the first entry of each group
 * is the diacritic spelling, and the ASCII one is derived by folding the
 * finished query.
 */
function latinCaseForms(municipality: Municipality): CaseForms {
  const groups: string[] = [];
  let previousFold: string | null = null;
  for (const variant of municipality.search_variants) {
    const fold = foldDiacritics(variant).toLowerCase();
    if (fold !== previousFold) groups.push(variant);
    previousFold = fold;
  }
  return caseFormsFrom(groups, municipality.name_sr);
}

function cyrillicCaseForms(municipality: Municipality): CaseForms {
  return caseFormsFrom([...municipality.search_variants_cyrillic], municipality.name_cyrillic);
}

/**
 * Read three case forms off a list, falling back to the nominative for any the
 * dataset does not carry. Never throws: a place with only a nominative still
 * produces queries, just fewer distinct ones after deduplication.
 */
function caseFormsFrom(forms: readonly string[], fallback: string): CaseForms {
  const nominative = forms[0] ?? fallback;
  return {
    nominative,
    locative: forms[1] ?? nominative,
    genitive: forms[2] ?? nominative,
  };
}

function cyrillicTerm(template: QueryTemplate): string | null {
  if (template.term_cyrillic === false) return null;
  return template.term_cyrillic ?? toCyrillic(template.term);
}

function resolveMunicipalities(
  municipality: string | readonly string[] | undefined,
): readonly Municipality[] {
  if (municipality === undefined) return [];
  const names = typeof municipality === 'string' ? [municipality] : municipality;
  return names.map((name) => {
    const resolved = getMunicipalityById(name) ?? findMunicipalityByName(name);
    if (resolved === undefined) {
      throw new Error(`Unknown municipality: ${JSON.stringify(name)}`);
    }
    return resolved;
  });
}

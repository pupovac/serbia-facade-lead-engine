/**
 * Portal Srbija's city slugs, resolved against the municipality dataset.
 *
 * The source publishes one page per (category × city) and links every one of
 * them from `dl.dl_nei`, so the enumeration comes from the source and the
 * *ordering and filtering* come from `data/serbia-geo.json`. That split is
 * deliberate, and it is what FUZZ-8's sweep was missing: iterating the
 * municipality dataset directly asks for pages that do not exist, and 14 of the
 * 49 slugs it tried returned a deterministic HTTP 500 — including `beograd`
 * itself, which this source simply has no page for. Every slug the source links
 * returned 200 with at least one company when this adapter was built.
 *
 * The dataset still decides three things:
 *
 * - **Order.** `municipalitiesByPriority()` — tier first, population second —
 *   so a run stopped by `--limit` or the request budget has covered the cities
 *   worth covering.
 * - **Scope.** `--city novi-sad` must not pull Belgrade pages, and Portal
 *   Srbija's slugs are neighbourhoods as often as municipalities
 *   (`karaburma`, `banovo-brdo`, `veternik`), so matching goes through
 *   `resolveCity` and its settlement aliases rather than through string
 *   equality.
 * - **What a slug means.** `zeleznik` is Čukarica, `palic` is Subotica,
 *   `stari-banovci` is Stara Pazova. Only the shared resolver knows that.
 *
 * A slug the dataset cannot place is **kept, not dropped** — six of the 77 on
 * the largest category are Belgrade neighbourhoods the settlement list has not
 * got yet (`kosutnjak-filmski-grad`, `zarkovo-cerak`) and small villages
 * (`desimirovac`, `dublje`). They hold real companies. They crawl last, and a
 * `--city` run skips them because there is no honest way to say whether they
 * are in scope.
 */
import type { Municipality } from '@/lib/geo';
import { municipalitiesByPriority } from '@/lib/geo';
import { resolveCityDetailed } from '@/lib/normalize';
import type { LocationLink } from './parse.js';

/** A city page, with whatever the dataset could say about where it is. */
export interface ResolvedLocation {
  readonly link: LocationLink;
  /** The most specific unit matched — `beograd-zemun`, `novi-sad`. */
  readonly cityId: string | null;
  /** The local self-government unit it rolls up to — `beograd`, `novi-sad`. */
  readonly municipalityId: string | null;
}

const priorityOf = new Map(municipalitiesByPriority().map((unit, index) => [unit.id, index]));

/**
 * A Portal Srbija city slug → a municipality.
 *
 * Slugs are compound as often as not: `cukarica-cukaricka-padina`,
 * `medakovic-veliki-mokri-lug`, `borca-krnjaca-kotez` — the site names a page
 * after every neighbourhood it covers. So the whole slug is tried first and
 * then progressively shorter prefixes, which is what makes
 * `rakovica-miljakovac-kanarevo-brdo-resnik` land on Rakovica instead of
 * nowhere. Longest match wins, so `nova-pazova` resolves as the settlement
 * Nova Pazova (Stara Pazova) rather than on the bare word `nova`.
 */
export function resolveCitySlug(citySlug: string): {
  cityId: string | null;
  municipalityId: string | null;
} {
  const words = citySlug.split('-').filter((word) => word !== '');
  for (let take = words.length; take >= 1; take -= 1) {
    const resolution = resolveCityDetailed(words.slice(0, take).join(' '));
    // `landline` cannot occur here — there is no phone — and `postal_code`
    // cannot either, so every match is a real name match.
    if (resolution.ok) {
      return {
        cityId: resolution.match.cityId,
        municipalityId: resolution.match.municipalityId,
      };
    }
  }
  return { cityId: null, municipalityId: null };
}

/** True when a resolved place is inside the run's `--city` scope. */
export function inScope(
  place: { readonly cityId: string | null; readonly municipalityId: string | null },
  scope: readonly Municipality[],
): boolean {
  if (scope.length === 0) return true;
  return scope.some(
    (unit) =>
      unit.id === place.cityId ||
      unit.id === place.municipalityId ||
      // `--city beograd` covers every Belgrade city municipality.
      (unit.parent_id !== null &&
        (unit.parent_id === place.cityId || unit.parent_id === place.municipalityId)),
  );
}

/**
 * The city pages to crawl for one category, in the order to crawl them.
 *
 * Placed slugs come first in dataset crawl order; unplaced ones follow in the
 * order the source listed them, and only when the run is not city-scoped.
 */
export function planLocations(
  locations: readonly LocationLink[],
  scope: readonly Municipality[],
): readonly ResolvedLocation[] {
  const resolved: ResolvedLocation[] = locations.map((link) => ({
    link,
    ...resolveCitySlug(link.citySlug),
  }));

  const placed = resolved
    .filter((entry) => entry.municipalityId !== null)
    .filter((entry) => inScope(entry, scope))
    .sort((a, b) => {
      const rank = (entry: ResolvedLocation): number =>
        priorityOf.get(entry.cityId ?? '') ?? priorityOf.get(entry.municipalityId ?? '') ?? 1e6;
      return rank(a) - rank(b) || a.link.citySlug.localeCompare(b.link.citySlug);
    });

  // A city-scoped run cannot claim an unplaced slug is in scope, so it skips
  // them. An unscoped run crawls them last: fewer companies, but real ones.
  const unplaced = scope.length === 0 ? resolved.filter((entry) => entry.cityId === null) : [];

  return [...placed, ...unplaced];
}

/** True when a company block's own `span.grad` string is inside the run's scope. */
export function cityTextInScope(city: string | null, scope: readonly Municipality[]): boolean {
  if (scope.length === 0) return true;
  if (city === null) return false;
  const resolution = resolveCityDetailed(city);
  if (!resolution.ok) return false;
  return inScope(
    { cityId: resolution.match.cityId, municipalityId: resolution.match.municipalityId },
    scope,
  );
}

/**
 * Canonical field shapes.
 *
 * Adapters hand raw scraped strings to this module and get back the values that
 * go into `leads`: a display name and its matching keys, and a location string
 * turned into `data/serbia-geo.json` slugs. Nothing here touches the database,
 * and nothing here decides a merge — `src/lib/dedup` does that, using the
 * similarity score and the confidence this module reports.
 */
export {
  characterSimilarity,
  nameSimilarity,
  normalizeCompanyName,
  normalizedNameSimilarity,
  RECOMMENDED_NAME_MATCH_THRESHOLD,
  type NormalizedCompanyName,
} from './name.js';
export {
  resolveCity,
  resolveCityDetailed,
  settlements,
  type CityFailureReason,
  type CityHint,
  type CityMatch,
  type CityMatchMethod,
  type CityResolution,
  type PhoneLike,
  type Settlement,
} from './city.js';

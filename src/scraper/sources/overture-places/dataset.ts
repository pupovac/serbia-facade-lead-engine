/**
 * Which bytes this adapter reads, and how it proves they are still there.
 *
 * Overture publishes the places theme as GeoParquet on a public S3 bucket, one
 * release per month, and the release string is part of the path. So the release
 * is **pinned** rather than resolved to "latest": a silently newer release would
 * change every number this source reports without a single line of code
 * changing, and a release that disappears must break the run loudly instead of
 * quietly reading a different month.
 */

/**
 * The release this adapter is built and measured against.
 *
 * Bump it deliberately, re-run, and update the counts in `README.md`. The
 * environment override exists so a monthly refresh can be scheduled without a
 * deploy; it is still a pin, just one somebody else chose.
 */
export const RELEASE = process.env.OVERTURE_RELEASE ?? '2026-08-19.0';

/** The bucket's HTTPS endpoint. `robots.txt` is a 404 here — see `README.md`. */
export const BUCKET_URL = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/';

/** Key prefix of the places theme inside the pinned release. */
export function placesPrefix(release: string = RELEASE): string {
  return `release/${release}/theme=places/type=place/`;
}

/**
 * The ListObjectsV2 call that both proves the release exists and enumerates the
 * parquet parts. This is the one request that goes through `ctx.http`, so the
 * bucket's `robots.txt`, the User-Agent and the retry policy all apply to it.
 */
export function listUrl(release: string = RELEASE): string {
  const params = new URLSearchParams({
    'list-type': '2',
    prefix: placesPrefix(release),
    'max-keys': '1000',
  });
  return `${BUCKET_URL}?${params.toString()}`;
}

/**
 * Keys out of a ListObjectsV2 response.
 *
 * Deliberately a regex over the XML rather than a parser: the response is a
 * flat, fixed shape from S3 itself, and pulling in an XML dependency to read
 * `<Key>` would be a runtime dependency for six characters of grammar.
 */
export function parseKeys(xml: string): readonly string[] {
  const keys: string[] = [];
  const pattern = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null = pattern.exec(xml);
  while (match !== null) {
    const key = match[1];
    if (key !== undefined && key.endsWith('.parquet')) keys.push(key);
    match = pattern.exec(xml);
  }
  return keys;
}

/** `true` when S3 says the listing was cut short — the parts would be incomplete. */
export function isTruncated(xml: string): boolean {
  return /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
}

/** Key → the HTTPS URL DuckDB reads it from. Same origin, same robots verdict. */
export function partUrl(key: string): string {
  return `${BUCKET_URL}${key}`;
}

/** Overture's own map viewer — the one place a GERS id renders as a business. */
export const EXPLORER_URL = 'https://explore.overturemaps.org/';

/**
 * The zoom a deep link opens at. High enough that the places layer is on (it
 * has `minzoom: 14`) and the pin is unambiguous on a city street.
 */
const EXPLORER_ZOOM = 18;

/**
 * Where a record points back to.
 *
 * This used to be the S3 prefix with the GERS id in the fragment. It was
 * honest provenance and completely unusable: FUZZ-22's spot check could not
 * verify **6 of its 30 sampled leads** because there was nothing to open, and
 * 607 of this source's 1,638 leads carry no website either, so for those there
 * was no page a reviewer could reach at all.
 *
 * So a record now points at Overture's own explorer, deep-linked to the
 * feature. The `feature` parameter is `<source>.<sourceLayer>.<gersId>`, which
 * is what the viewer reads to select and inspect a place; the hash is
 * `#zoom/lat/lng`, which is what it reads to centre the map. Provenance is not
 * lost — the GERS id is right there in the URL, and the release stays on the
 * record in `extra.release`.
 *
 * The release is deliberately **not** in the URL any more. It used to be, via
 * the S3 path, which meant every monthly release changed every `source_url` and
 * an incremental re-run could not recognize a page it had already seen. A GERS
 * id is stable across releases; the link now is too.
 */
export function placeUrl(
  gersId: string,
  coordinates?: { readonly latitude: number; readonly longitude: number } | undefined,
): string {
  const params = new URLSearchParams({ feature: `places.place.${gersId}`, mode: 'inspect' });
  const hash =
    coordinates === undefined
      ? ''
      : `#${EXPLORER_ZOOM}/${round(coordinates.latitude)}/${round(coordinates.longitude)}`;
  return `${EXPLORER_URL}?${params.toString()}${hash}`;
}

/** Six decimals is ~10 cm — more than a map link can use, and it keeps URLs stable. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

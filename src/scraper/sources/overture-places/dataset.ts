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

/**
 * Where a record points back to.
 *
 * A bulk dataset has no per-record web page, and inventing one would be worse
 * than admitting that: the honest provenance of an Overture record is the
 * release it came from plus its GERS id, which is exactly what this encodes.
 * Re-query that release for that id and you get the row this lead was built
 * from — which is what `sourceUrl` is for.
 */
export function placeUrl(gersId: string, release: string = RELEASE): string {
  return `${BUCKET_URL}${placesPrefix(release)}#${gersId}`;
}

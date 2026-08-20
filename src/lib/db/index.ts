/**
 * The database layer's public surface.
 *
 * Import from `@/lib/db` — the scraper, the API routes and the export writer
 * should never reach past this barrel into a table definition. `schema.ts` is
 * re-exported for the migration tooling and for tests that need to assert on a
 * column directly.
 */
export * from './client.js';
export * from './repo.js';
export * from './schema.js';
export { registrySourceRows, seedSources } from './seed-sources.js';

/**
 * Reproduces the query-set size table in
 * `research/2026-08-19-fuzz-7-query-library.md`.
 *
 *     npx tsx scripts/report-query-set.ts
 */
import {
  generateTierQueries,
  queryTemplates,
  termInventoryCounts,
  type QueryScript,
  type QueryVariant,
} from '../src/lib/queries.js';
import { municipalitiesInTier } from '../src/lib/geo.js';

const CONTRACTOR = 'FACADE_CONTRACTOR';
const STORE = 'CONSTRUCTION_MATERIAL_STORE';
const VARIANTS: readonly QueryVariant[] = ['narrow', 'core', 'all'];
const LATIN: readonly QueryScript[] = ['latin'];
const BOTH_SCRIPTS: readonly QueryScript[] = ['latin', 'cyrillic'];

const counts = termInventoryCounts();
console.log(`templates: ${counts.total}`);
console.log(`  contractor terms: ${counts.byLeadType[CONTRACTOR]}`);
console.log(`  store terms:      ${counts.byLeadType[STORE]}`);
console.log(
  `  narrow/medium/broad: ${counts.byPrecision.narrow}/${counts.byPrecision.medium}/${counts.byPrecision.broad}`,
);
console.log(`tier-1 municipalities: ${municipalitiesInTier(1).length}\n`);

console.log('variant  contractor  store   both    both+cyrillic');
for (const variant of VARIANTS) {
  const contractor = generateTierQueries(1, { leadType: CONTRACTOR, variant, scripts: LATIN });
  const store = generateTierQueries(1, { leadType: STORE, variant, scripts: LATIN });
  const both = generateTierQueries(1, { leadType: [CONTRACTOR, STORE], variant, scripts: LATIN });
  const cyrillic = generateTierQueries(1, {
    leadType: [CONTRACTOR, STORE],
    variant,
    scripts: BOTH_SCRIPTS,
  });
  console.log(
    [
      variant.padEnd(8),
      String(contractor.length).padEnd(11),
      String(store.length).padEnd(7),
      String(both.length).padEnd(7),
      String(cyrillic.length),
    ].join(''),
  );
}

const sample = generateTierQueries(1, { leadType: [CONTRACTOR, STORE], variant: 'core' });
console.log(`\n10 representative queries from the ${sample.length}-query tier-1 core set:`);
const step = Math.floor(sample.length / 10);
for (let i = 0; i < 10; i += 1) {
  const query = sample[i * step];
  if (query) console.log(`  ${query.query}  [${query.template_id} · ${query.precision}]`);
}

console.log(
  `\nterms with no Cyrillic form: ${queryTemplates.filter((t) => t.term_cyrillic === false).length}`,
);

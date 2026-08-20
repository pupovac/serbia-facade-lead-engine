/**
 * Classify every company in the `portal-srbija` fixture set and print the
 * label distribution, with the reason behind each `UNKNOWN`.
 *
 *   npx tsx scripts/report-portal-srbija-classification.ts [--unknown]
 *
 * FUZZ-30 asks for a before/after `UNKNOWN` count on this source, and a number
 * nobody can re-run is not a measurement. The fixtures are the pages saved on
 * 2026-08-20, so this reproduces without touching the network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { classifyLead } from '../src/lib/classify/index.js';
import type { LeadClassification } from '../src/lib/classify/types.js';
import { CATEGORIES } from '../src/scraper/sources/portal-srbija/categories.js';
import {
  parseDetail,
  parseListing,
  type Expect,
} from '../src/scraper/sources/portal-srbija/parse.js';
import { expectFound } from '../src/scraper/types.js';

const FIXTURES = new URL('../src/scraper/sources/portal-srbija/__fixtures__/', import.meta.url);
const BASE = 'https://www.portal-srbija.com';
const expect: Expect = (value, selector, url, expected) =>
  expectFound('portal-srbija', value, selector, url, expected);

interface Record {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | undefined;
  readonly website: string | undefined;
}

const records = new Map<string, Record>();

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.html'))) {
  const $ = cheerio.load(readFileSync(new URL(file, FIXTURES), 'utf8'));
  const url = `${BASE}/${file.replace(/^(listing|detail)-(city|national)?-?/, '').replace(/\.html$/, '')}`;

  if (file.startsWith('detail-')) {
    const lead = parseDetail($, url, expect);
    records.set(lead.name.toLowerCase(), {
      key: lead.name.toLowerCase(),
      name: lead.name,
      category: (lead.categories ?? []).join(', '),
      description: lead.description ?? undefined,
      website: lead.website ?? undefined,
    });
    continue;
  }

  const slug = url.slice(BASE.length + 1);
  const category = CATEGORIES.find((c) => slug.startsWith(c.slug));
  const listing = parseListing($, url, expect, {
    categorySlug: category?.slug ?? slug,
    requireItems: false,
  });
  for (const item of listing.items) {
    const key = item.name.trim().toLowerCase();
    // A company appears on the national page and on its city page; the record
    // that carries a description is the one worth keeping.
    const seen = records.get(key);
    if (seen !== undefined && (seen.description !== undefined || item.description === null)) {
      continue;
    }
    records.set(key, {
      key,
      name: item.name,
      category: listing.heading,
      description: item.description ?? undefined,
      website: undefined,
    });
  }
}

const counts = new Map<LeadClassification, number>();
const unknowns: string[] = [];

for (const record of [...records.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const result = classifyLead({
    name: record.name,
    categories: [record.category],
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.website === undefined ? {} : { website: record.website }),
  });
  counts.set(result.label, (counts.get(result.label) ?? 0) + 1);
  if (result.label === 'UNKNOWN') {
    unknowns.push(
      `${record.name} — category "${record.category}"\n    ${result.reason}\n    evidence: ${
        result.evidence.map((e) => `${e.signalId}@${e.field}=${e.weight}`).join(', ') || 'none'
      }`,
    );
  }
}

console.log(`portal-srbija fixture records: ${records.size}`);
for (const label of [
  'FACADE_CONTRACTOR',
  'CONSTRUCTION_MATERIAL_STORE',
  'BOTH',
  'UNKNOWN',
] as const) {
  console.log(`  ${label.padEnd(28)} ${counts.get(label) ?? 0}`);
}

if (process.argv.includes('--unknown')) {
  console.log('\nUNKNOWN records');
  for (const line of unknowns) console.log(`  ${line}`);
}

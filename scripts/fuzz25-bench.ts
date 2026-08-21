/**
 * Lead-list performance at volume.
 *
 * The acceptance criterion is "server-side filtering and pagination stay
 * responsive at 20k+ leads", and twelve seed rows prove nothing. So this builds
 * a scaled copy of the *real* pilot database — every synthetic lead is a clone
 * of a real one, with a real Serbian name, a real municipality and a real phone
 * shape — and times the queries the UI actually issues against it.
 *
 *   npx tsx scripts/fuzz25-bench.ts [targetLeads]
 *
 * The scaled file is written to `data/leads-bench.sqlite` and is gitignored
 * like every other `*.sqlite`. It is a volume fixture, not a data fixture: the
 * views themselves are only ever validated against the untouched pilot file.
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { closeDatabase, openDatabase } from '../src/lib/db/index.js';
import {
  activeLeadCount,
  leadContactClaims,
  leadPhoneClaims,
  upsertLead,
  upsertSource,
  type LeadInput,
} from '../src/lib/db/repo.js';
import { leads } from '../src/lib/db/schema.js';
import { isNull } from 'drizzle-orm';
import { dashboardStats, leadFacets, listLeads, mergeQueue } from '../src/lib/review/index.js';

const SOURCE = process.env.DATABASE_PATH ?? './data/leads.sqlite';
const SCALED = './data/leads-bench.sqlite';
const TARGET = Number.parseInt(process.argv[2] ?? '25000', 10);

const BENCH_SOURCE = 'bench-clone';

function build(): void {
  if (!existsSync(SOURCE)) throw new Error(`no pilot database at ${SOURCE}`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${SCALED}${suffix}`, { force: true });
  copyFileSync(SOURCE, SCALED);

  const db = openDatabase({ url: SCALED, migrate: false });
  upsertSource(db, {
    id: BENCH_SOURCE,
    name: 'Benchmark clone',
    url: 'internal://bench',
    category: 'synthetic volume',
    enabled: false,
  });

  const originals = db.select().from(leads).where(isNull(leads.mergedIntoId)).all();
  const templates = originals.map((lead) => ({
    lead,
    phones: leadPhoneClaims(db, lead.id),
    contacts: leadContactClaims(db, lead.id),
  }));

  let created = activeLeadCount(db);
  let round = 0;
  console.log(`pilot: ${created} active leads — cloning up to ${TARGET}`);

  const started = Date.now();
  db.$client.transaction(() => {
    while (created < TARGET) {
      round += 1;
      for (const template of templates) {
        if (created >= TARGET) break;
        const { lead } = template;
        const tag = `K${round}`;
        const input: LeadInput = {
          name: `${lead.name} ${tag}`,
          nameNormalized: `${lead.nameNormalized} ${tag.toLowerCase()}`,
          classification: lead.classification,
          classificationConfidence: lead.classificationConfidence,
          cityId: lead.cityId,
          municipalityId: lead.municipalityId,
          cityRaw: lead.cityRaw,
          address: lead.address,
          postalCode: lead.postalCode,
          leadScore: lead.leadScore,
          // A distinct number per clone, keeping the +381 shape and the
          // mobile/landline split the real corpus has.
          phones: template.phones.slice(0, 4).map((phone) => ({
            e164: phone.valid ? shiftNumber(phone.e164, round) : phone.e164,
            raw: phone.raw,
            type: phone.type,
            valid: phone.valid,
          })),
          contacts: template.contacts.slice(0, 3).map((contact) => ({
            kind: contact.kind,
            value: `${round}.${contact.value}`,
            valueRaw: contact.valueRaw,
            domain: contact.domain == null ? null : `${round}.${contact.domain}`,
          })),
        };
        upsertLead(
          db,
          input,
          { sourceId: BENCH_SOURCE, sourceUrl: `internal://bench/${round}/${lead.id}` },
          { matching: 'caller' },
        );
        created += 1;
      }
    }
  })();

  console.log(`built ${created} leads in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  closeDatabase(db);
}

/** Keep the `+381` prefix and the digit count; vary the subscriber part. */
function shiftNumber(e164: string, round: number): string {
  const digits = e164.replace(/\D/g, '');
  if (!digits.startsWith('381') || digits.length < 11) return `${e164}-${round}`;
  const head = digits.slice(0, 5);
  const tail = digits.slice(5);
  const shifted = String((Number.parseInt(tail, 10) + round * 7919) % 10 ** tail.length).padStart(
    tail.length,
    '0',
  );
  return `+${head}${shifted}`;
}

function time(label: string, run: () => unknown, iterations = 12): void {
  run(); // warm the statement cache the way a running server already has
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
  console.log(
    `${label.padEnd(52)} median ${median.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms`,
  );
}

function measure(path: string): void {
  const db = openDatabase({ url: path, migrate: false, readonly: true });
  const total = activeLeadCount(db);
  console.log(`\n=== ${path} — ${total} active leads ===`);

  time('list, default sort, page 1', () => listLeads(db, { pageSize: 50 }));
  time('list, page 200 (deep offset)', () => listLeads(db, { pageSize: 50, page: 200 }));
  time('list, hasPhone + minScore 60', () =>
    listLeads(db, { pageSize: 50, hasPhone: true, minScore: 60 }),
  );
  time('list, municipality = beograd', () =>
    listLeads(db, { pageSize: 50, municipalityId: 'beograd' }),
  );
  time('list, source = gradjevinarstvo-rs', () =>
    listLeads(db, { pageSize: 50, sourceId: 'gradjevinarstvo-rs' }),
  );
  time('list, text search "fasad"', () => listLeads(db, { pageSize: 50, search: 'fasad' }));
  time('list, phone search "064"', () => listLeads(db, { pageSize: 50, search: '064 123 4567' }));
  time('list, sort by name asc', () =>
    listLeads(db, { pageSize: 50, sort: 'name', direction: 'asc' }),
  );
  time('list, every filter combined', () =>
    listLeads(db, {
      pageSize: 50,
      search: 'fasad',
      municipalityId: 'beograd',
      hasPhone: true,
      minScore: 40,
      classifications: ['UNKNOWN', 'CONSTRUCTION_MATERIAL_STORE'],
      sort: 'score',
    }),
  );
  time('facets (filter vocabulary)', () => leadFacets(db), 6);
  time('dashboard (every aggregate)', () => dashboardStats(db), 6);
  time('merge queue, page 1', () => mergeQueue(db, 1, 8), 6);

  closeDatabase(db);
}

measure(SOURCE);
if (process.env.SKIP_SCALE !== '1') {
  build();
  measure(SCALED);
}

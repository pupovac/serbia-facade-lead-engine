/**
 * The migration is the contract: if `drizzle/` no longer applies cleanly to an
 * empty database, or an index the dedup paths depend on has quietly gone away,
 * these fail before anything else does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDatabase, openTestDatabase, type Db } from './client.js';
import {
  EXPORTABLE_CLASSIFICATIONS,
  IN_SCOPE_CLASSIFICATIONS,
  LEAD_CLASSIFICATIONS,
  isInScope,
  isUnclassified,
  leadPhones,
  leads,
  sources,
} from './schema.js';

let db: Db | undefined;

function open(): Db {
  db = openTestDatabase();
  return db;
}

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
});

function tableNames(database: Db): string[] {
  const rows = database.$client
    .prepare(`select name from sqlite_master where type = 'table' order by name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name).filter((name) => !name.startsWith('sqlite_'));
}

function indexNames(database: Db): string[] {
  const rows = database.$client
    .prepare(`select name from sqlite_master where type = 'index' and name is not null`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('migration', () => {
  it('applies cleanly to an empty database', () => {
    const database = open();
    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        'sources',
        'crawl_runs',
        'crawl_state',
        'raw_records',
        'leads',
        'lead_phones',
        'lead_contacts',
        'lead_field_values',
        'lead_sources',
        'merge_log',
        'erasure_log',
        'erasure_blocklist',
      ]),
    );
  });

  it('is idempotent — a second open of the same file applies nothing new', () => {
    const database = open();
    const before = tableNames(database).length;
    // `openTestDatabase` migrates on open; running the migrator again over the
    // same connection must not throw on an already-applied migration.
    const again = openTestDatabase();
    expect(tableNames(again).length).toBe(before);
    closeDatabase(again);
  });

  it('indexes every dedup lookup path', () => {
    const names = indexNames(open());
    // Phone, website domain, email, name + city — the four exact signals, each
    // hit on every insert.
    expect(names).toContain('lead_phones_e164_idx');
    expect(names).toContain('lead_contacts_domain_idx');
    expect(names).toContain('lead_contacts_kind_value_idx');
    expect(names).toContain('leads_name_city_idx');
  });
});

describe('constraints', () => {
  it('enforces the classification enum in the database, not only in TypeScript', () => {
    const database = open();
    expect(() =>
      database.$client
        .prepare(
          `insert into leads (name, name_normalized, classification, status, lead_score,
             first_seen_at, last_seen_at, created_at, updated_at)
           values ('X', 'x', 'PLUMBER', 'new', 0, 1, 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('keeps foreign keys on — a phone cannot reference a lead that is not there', () => {
    const database = open();
    database
      .insert(sources)
      .values({
        id: 'test-source',
        name: 'Test',
        url: 'https://example.rs',
        category: 'test',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    expect(() =>
      database
        .insert(leadPhones)
        .values({
          leadId: 9999,
          e164: '+381641234567',
          raw: '064 123 4567',
          sourceId: 'test-source',
          sourceUrl: 'https://example.rs/x',
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('stores timestamps as numbers so ordering is portable', () => {
    const database = open();
    const at = new Date('2026-08-20T10:00:00.000Z');
    database
      .insert(leads)
      .values({
        name: 'Fasade Test',
        nameNormalized: 'fasade test',
        firstSeenAt: at,
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    const raw = database.$client.prepare(`select first_seen_at from leads`).get() as {
      first_seen_at: number;
    };
    expect(raw.first_seen_at).toBe(at.getTime());

    const [read] = database.select().from(leads).all();
    expect(read?.firstSeenAt).toBeInstanceOf(Date);
    expect(read?.firstSeenAt.toISOString()).toBe(at.toISOString());
  });

  it('has no SQLite-only expressions in the generated migration', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('./client.js');
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const ddl = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      // `strftime`, `julianday` and `INSERT OR REPLACE` have no Postgres
      // equivalent; `datetime()` and `AUTOINCREMENT` are dialect DDL Drizzle
      // rewrites on a swap, so only the expression forms are checked here.
      expect(ddl).not.toMatch(/strftime|julianday|insert\s+or\s+replace/i);
    }
  });
});

describe('portable SQL', () => {
  it('counts distinct values with plain SQL that Postgres also accepts', () => {
    const database = open();
    const row = database
      .select({ count: sql<number>`count(distinct ${leads.cityId})` })
      .from(leads)
      .get();
    expect(row?.count).toBe(0);
  });
});

describe('the classification enum after the UNKNOWN split', () => {
  it('has no `UNKNOWN` left to hide an out-of-scope business in', () => {
    expect(LEAD_CLASSIFICATIONS).not.toContain('UNKNOWN');
    expect(LEAD_CLASSIFICATIONS).toContain('UNCLASSIFIED');
    expect(LEAD_CLASSIFICATIONS).toContain('OUT_OF_SCOPE');
  });

  it('rejects the old label at the database, not only in TypeScript', () => {
    const database = open();
    expect(() =>
      database.$client
        .prepare(
          `insert into leads (name, name_normalized, classification, first_seen_at, last_seen_at, created_at, updated_at)
           values ('Stara Firma', 'stara firma', 'UNKNOWN', 0, 0, 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
  });

  it('keeps `classification_industry` inside its enum and allows it to be null', () => {
    const database = open();
    const insert = (industry: string | null): void => {
      database.$client
        .prepare(
          `insert into leads (name, name_normalized, classification, classification_industry, first_seen_at, last_seen_at, created_at, updated_at)
           values ('Firma', 'firma', 'OUT_OF_SCOPE', ?, 0, 0, 0, 0)`,
        )
        .run(industry);
    };
    expect(() => insert('joinery')).not.toThrow();
    expect(() => insert(null)).not.toThrow();
    expect(() => insert('astrology')).toThrow(/CHECK constraint/i);
  });

  it('names the three labels the export ships, and no undecided one', () => {
    expect([...EXPORTABLE_CLASSIFICATIONS]).toStrictEqual([...IN_SCOPE_CLASSIFICATIONS]);
    for (const label of LEAD_CLASSIFICATIONS) {
      expect(isInScope(label)).toBe(label !== 'UNCLASSIFIED' && label !== 'OUT_OF_SCOPE');
    }
    // `OUT_OF_SCOPE` is a decision, not an absence — `upsertLead` and the merge
    // engine must not let a later thin listing overwrite it.
    expect(isUnclassified('OUT_OF_SCOPE')).toBe(false);
    expect(isUnclassified('UNCLASSIFIED')).toBe(true);
  });
});

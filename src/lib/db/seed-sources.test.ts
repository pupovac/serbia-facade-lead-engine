import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from './client.js';
import { parseRobotsVerdict, registrySourceRows, seedSources } from './seed-sources.js';
import { getSource } from './repo.js';
import { sources } from './schema.js';

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
});

afterEach(() => {
  closeDatabase(db);
});

describe('registrySourceRows', () => {
  it('carries every source from both registries, with the overlap merged once', () => {
    const rows = registrySourceRows();
    // 32 contractor + 20 store entries, 3 of which appear in both.
    expect(rows).toHaveLength(49);
    expect(new Set(rows.map((r) => r.id)).size).toBe(49);
  });

  it('unions the segment flags for a source both registries listed', () => {
    const both = registrySourceRows().find((r) => r.id === 'kupujemprodajem');
    expect(both?.hasContractors).toBe(true);
    expect(both?.hasStores).toBe(true);
    expect(both?.registryFiles).toContain('sources-contractors.json');
    expect(both?.registryFiles).toContain('sources-stores.json');
  });

  it('keeps the high-priority sources the research measured', () => {
    const rows = registrySourceRows();
    const high = rows.filter((r) => r.priority === 'high').map((r) => r.id);
    expect(high).toContain('portal-srbija');
    expect(high).toContain('austrotherm-distributeri');
  });

  it('keeps a rejected source on record, disabled', () => {
    const rejected = registrySourceRows().filter((r) => r.priority === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => r.enabled === false)).toBe(true);
    // Facebook page scraping was ruled out; the row explains that it was looked at.
    expect(rejected.map((r) => r.id)).toContain('facebook-pages');
  });
});

describe('parseRobotsVerdict', () => {
  it.each([
    [true, true],
    [false, false],
    [null, null],
    [undefined, null],
    ['ALLOWED. https://www.portal-srbija.com/robots.txt: "User-Agent: *" / "Allow: /"', true],
    ['ALLOWED for /firme/{id}/{slug}. …', true],
    ['DISALLOWED — /search is blocked', false],
    // Nothing forbids it, but nothing permits it in writing either.
    ['NO robots.txt PUBLISHED. … returns HTTP 404', null],
  ])('reads %p as %p', (input, expected) => {
    expect(parseRobotsVerdict(input as boolean | string | null | undefined)).toBe(expected);
  });
});

describe('seedSources', () => {
  it('writes the registries into the database', () => {
    expect(seedSources(db)).toBe(49);
    expect(db.select().from(sources).all()).toHaveLength(49);

    const portal = getSource(db, 'portal-srbija');
    expect(portal?.name).toBe('Portal Srbija');
    expect(portal?.priority).toBe('high');
    expect(portal?.robotsAllows).toBe(true);
    expect(portal?.robotsRule).toContain('robots.txt');
  });

  it('is idempotent — a re-seed refreshes rows and keeps created_at', () => {
    const first = new Date('2026-08-20T09:00:00Z');
    seedSources(db, first);
    const before = getSource(db, 'portal-srbija');

    const second = new Date('2026-09-01T09:00:00Z');
    seedSources(db, second);
    const after = getSource(db, 'portal-srbija');

    expect(db.select().from(sources).all()).toHaveLength(49);
    expect(after?.createdAt.toISOString()).toBe(before?.createdAt.toISOString());
    expect(after?.updatedAt.toISOString()).toBe(second.toISOString());
  });
});

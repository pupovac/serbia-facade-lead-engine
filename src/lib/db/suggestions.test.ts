/**
 * The enrichment review queue.
 *
 * The property that matters is that a reviewer's `no` sticks. Without it every
 * re-run re-opens the suggestions a human has already worked through, and the
 * queue becomes something nobody opens twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openTestDatabase, type Db } from './client.js';
import { upsertLead, upsertSource, type Provenance } from './repo.js';
import {
  pendingSuggestions,
  recordSuggestion,
  rejectedValues,
  resolveSuggestion,
  suggestionsForLead,
  type SuggestionInput,
} from './suggestions.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const LATER = new Date('2026-09-20T12:00:00Z');

let db: Db;
let leadId: number;

const PROVENANCE: Provenance = {
  sourceId: 'search-enrichment',
  sourceUrl: 'https://petrovic-fasade-ns.rs/',
};

function suggestion(overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    leadId,
    kind: 'phone',
    value: '+381628887744',
    valueRaw: '062 888 77 44',
    sourceUrl: 'https://petrovic-fasade-ns.rs/',
    origin: 'discovered',
    confidence: 0.6,
    rule: 'name_city_alone',
    reason: 'a strong name match in the same place, with nothing corroborating it',
    evidence: '{"signals":[]}',
    seenAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  db = openTestDatabase();
  upsertSource(db, {
    id: 'search-enrichment',
    name: 'Search-discovered contact enrichment',
    url: 'https://example.invalid',
    category: 'enrichment',
  });
  leadId = upsertLead(
    db,
    { name: 'Fasade Petrović', nameNormalized: 'fasade petrovic', cityId: 'novi-sad' },
    PROVENANCE,
  ).leadId;
});

afterEach(() => {
  closeDatabase(db);
});

describe('recordSuggestion', () => {
  it('queues a value with the evidence a reviewer needs', () => {
    const result = recordSuggestion(db, suggestion());
    expect(result.created).toBe(true);

    const row = pendingSuggestions(db, { leadId })[0];
    expect(row).toMatchObject({
      kind: 'phone',
      value: '+381628887744',
      valueRaw: '062 888 77 44',
      origin: 'discovered',
      rule: 'name_city_alone',
      status: 'pending',
    });
  });

  it('refreshes rather than duplicates when the same page is read again', () => {
    recordSuggestion(db, suggestion());
    const second = recordSuggestion(db, suggestion({ confidence: 0.7, seenAt: LATER }));

    expect(second.created).toBe(false);
    const rows = suggestionsForLead(db, leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBe(0.7);
    expect(rows[0]?.lastSeenAt).toEqual(LATER);
    expect(rows[0]?.firstSeenAt).toEqual(NOW);
  });

  it('keeps two different values for one lead apart', () => {
    recordSuggestion(db, suggestion());
    recordSuggestion(db, suggestion({ kind: 'email', value: 'fasade.petrovic.ns@gmail.com' }));
    expect(pendingSuggestions(db, { leadId })).toHaveLength(2);
  });
});

describe('the queue', () => {
  it('lists the best evidence first', () => {
    recordSuggestion(db, suggestion({ value: '+381628887744', confidence: 0.55 }));
    recordSuggestion(db, suggestion({ value: '+381641119922', confidence: 0.85 }));

    expect(pendingSuggestions(db).map((row) => row.value)).toEqual([
      '+381641119922',
      '+381628887744',
    ]);
  });

  it('drops a resolved suggestion out of the pending list', () => {
    const { id } = recordSuggestion(db, suggestion());
    resolveSuggestion(db, id, 'accepted', 'reviewer:1', LATER);

    expect(pendingSuggestions(db)).toEqual([]);
    expect(pendingSuggestions(db, { status: 'accepted' })).toHaveLength(1);
    expect(suggestionsForLead(db, leadId)[0]).toMatchObject({
      status: 'accepted',
      resolvedBy: 'reviewer:1',
      resolvedAt: LATER,
    });
  });

  it('honours a limit', () => {
    recordSuggestion(db, suggestion({ value: '+381628887744' }));
    recordSuggestion(db, suggestion({ value: '+381641119922' }));
    expect(pendingSuggestions(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('a reviewer’s no', () => {
  it('is remembered, and a re-read of the same page does not re-open it', () => {
    const { id } = recordSuggestion(db, suggestion());
    resolveSuggestion(db, id, 'rejected', 'reviewer:1', LATER);

    recordSuggestion(db, suggestion({ confidence: 0.89, seenAt: LATER }));

    expect(suggestionsForLead(db, leadId)[0]?.status).toBe('rejected');
    expect(pendingSuggestions(db)).toEqual([]);
  });

  it('is readable as the (kind, value) pairs the merge path must skip', () => {
    const { id } = recordSuggestion(db, suggestion());
    recordSuggestion(db, suggestion({ kind: 'email', value: 'x@y.rs' }));
    resolveSuggestion(db, id, 'rejected', 'reviewer:1', LATER);

    const rejected = rejectedValues(db, leadId);
    expect(rejected.has('phone:+381628887744')).toBe(true);
    expect(rejected.has('email:x@y.rs')).toBe(false);
  });

  it('reports nothing for a lead nobody has reviewed', () => {
    expect(rejectedValues(db, leadId).size).toBe(0);
  });
});

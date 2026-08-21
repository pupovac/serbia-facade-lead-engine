/**
 * The lead detail page's read model, and the two review queues'.
 *
 * Everything is assembled from the repository's own accessors —
 * `distinctPhones`, `fieldConflicts`, `mergeHistoryFor` — so the collapsing and
 * conflict rules the scraper obeys are the same ones a reviewer sees.
 */
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../db/repo.js';
import {
  distinctPhones,
  fieldConflicts,
  leadContactClaims,
  leadFieldClaims,
  leadSourceRows,
  distinctSourceCount,
  mergeHistoryFor,
  resolveLead,
} from '../db/repo.js';
import { suggestionsForLead } from '../db/suggestions.js';
import {
  type Lead,
  type LeadContact,
  enrichmentSuggestions,
  leadPhones,
  leads,
  mergeCandidates,
  sources,
} from '../db/schema.js';
import type {
  CandidateSide,
  LeadDetail,
  MergeCandidatePair,
  MergeQueuePage,
  SourceSighting,
  SuggestionQueuePage,
  SuggestionWithLead,
} from './types.js';

/**
 * Whether a stored source URL points at something a human can open.
 *
 * The Overture extract's `source_url` is an S3 object prefix with a GERS id in
 * the fragment — 1,638 of the pilot's 3,601 leads. It is correct provenance and
 * a dead link, so it is rendered as evidence, not as an anchor. FUZZ-33 is
 * fixing the ingest side; this predicate is what keeps the UI honest until then.
 */
export function isBrowsableSourceUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/overturemaps-[a-z0-9-]+\.s3\./i.test(url)) return false;
  // A URL whose only distinguishing part is a fragment resolves to a directory
  // listing, whatever host it is on.
  const [base] = url.split('#');
  return base != null && !/\/$/.test(base);
}

function sightingsFor(db: Executor, leadId: number): SourceSighting[] {
  const rows = leadSourceRows(db, leadId);
  if (rows.length === 0) return [];
  const names = new Map(
    db
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(inArray(sources.id, [...new Set(rows.map((r) => r.sourceId))]))
      .all()
      .map((row) => [row.id, row.name] as const),
  );
  return rows
    .map((row) => ({
      ...row,
      sourceName: names.get(row.sourceId) ?? row.sourceId,
      browsable: isBrowsableSourceUrl(row.sourceUrl),
    }))
    .sort(
      (a, b) => a.sourceName.localeCompare(b.sourceName) || a.sourceUrl.localeCompare(b.sourceUrl),
    );
}

/** Everything known about one business, including the claims that lost. */
export function leadDetail(db: Executor, leadId: number): LeadDetail | undefined {
  const lead = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) return undefined;

  const allPhones = distinctPhones(db, leadId);
  return {
    lead,
    resolvesTo: lead.mergedIntoId == null ? null : (resolveLead(db, leadId) ?? null),
    phones: allPhones.filter((phone) => phone.valid),
    invalidPhones: allPhones.filter((phone) => !phone.valid),
    contacts: [...leadContactClaims(db, leadId)].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
    ),
    sightings: sightingsFor(db, leadId),
    fieldClaims: [...leadFieldClaims(db, leadId)].sort(
      (a, b) => a.field.localeCompare(b.field) || Number(b.isCurrent) - Number(a.isCurrent),
    ),
    conflicts: fieldConflicts(db, leadId),
    mergeHistory: mergeHistoryFor(db, leadId),
    suggestions: suggestionsForLead(db, leadId),
    sourceCount: distinctSourceCount(db, leadId),
  };
}

function candidateSide(db: Executor, lead: Lead): CandidateSide {
  return {
    lead,
    phones: distinctPhones(db, lead.id).filter((phone) => phone.valid),
    contacts: leadContactClaims(db, lead.id).filter(
      (contact) => contact.kind === 'website' || contact.kind === 'email',
    ),
    sightings: sightingsFor(db, lead.id),
    sourceCount: distinctSourceCount(db, lead.id),
  };
}

/**
 * The merge review queue: pairs the dedup engine scored into the review band,
 * strongest evidence first, one page at a time.
 *
 * 347 pairs are pending in the pilot. Ordering by score means the reviewer
 * spends their first ten minutes on the ten pairs most likely to be one
 * business.
 */
export function mergeQueue(db: Executor, page = 1, pageSize = 10): MergeQueuePage {
  const total =
    db
      .select({ value: count() })
      .from(mergeCandidates)
      .where(eq(mergeCandidates.status, 'pending'))
      .get()?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pageCount, Math.max(1, Math.trunc(page)));

  const rows = db
    .select()
    .from(mergeCandidates)
    .where(eq(mergeCandidates.status, 'pending'))
    .orderBy(desc(mergeCandidates.score), asc(mergeCandidates.id))
    .limit(pageSize)
    .offset((current - 1) * pageSize)
    .all();

  const pairs = rows.flatMap((candidate): MergeCandidatePair[] => {
    const a = db.select().from(leads).where(eq(leads.id, candidate.leadAId)).get();
    const b = db.select().from(leads).where(eq(leads.id, candidate.leadBId)).get();
    if (!a || !b) return [];
    return [{ candidate, a: candidateSide(db, a), b: candidateSide(db, b) }];
  });

  return { pairs, total, page: current, pageSize, pageCount };
}

/** The enrichment queue: medium-confidence findings, best evidence first. */
export function suggestionQueue(db: Executor, page = 1, pageSize = 20): SuggestionQueuePage {
  const total =
    db
      .select({ value: count() })
      .from(enrichmentSuggestions)
      .where(eq(enrichmentSuggestions.status, 'pending'))
      .get()?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pageCount, Math.max(1, Math.trunc(page)));

  const rows = db
    .select()
    .from(enrichmentSuggestions)
    .where(eq(enrichmentSuggestions.status, 'pending'))
    .orderBy(desc(enrichmentSuggestions.confidence), asc(enrichmentSuggestions.id))
    .limit(pageSize)
    .offset((current - 1) * pageSize)
    .all();

  const items = rows.flatMap((suggestion): SuggestionWithLead[] => {
    const lead = db.select().from(leads).where(eq(leads.id, suggestion.leadId)).get();
    if (!lead) return [];
    const existingPhones = db
      .select({ e164: leadPhones.e164 })
      .from(leadPhones)
      .where(and(eq(leadPhones.leadId, lead.id), eq(leadPhones.valid, true)))
      .all()
      .map((row) => row.e164);
    return [
      {
        suggestion,
        lead,
        existingPhones: [...new Set(existingPhones)],
        existingContacts: leadContactClaims(db, lead.id) as LeadContact[],
      },
    ];
  });

  return { items, total, page: current, pageSize, pageCount };
}

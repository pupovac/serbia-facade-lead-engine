/**
 * `enrichment_suggestions` — the read and write paths for the medium-confidence
 * findings a human decides.
 *
 * It is a separate file from `repo.ts` for the same reason `seed-sources.ts`
 * is: the repository is the lead data model's accessor layer, and this is one
 * feature's queue on top of it. Nothing here decides anything — the confidence
 * rules live in `src/scraper/enrich/confidence.ts` and the caller arrives with
 * a verdict already reached.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import type { Executor } from './repo.js';
import {
  enrichmentSuggestions,
  type EnrichmentOrigin,
  type EnrichmentSuggestion,
  type SuggestionKind,
  type SuggestionStatus,
} from './schema.js';

/** One proposed value, with everything a reviewer needs to judge it. */
export interface SuggestionInput {
  readonly leadId: number;
  readonly kind: SuggestionKind;
  /** Canonical form — the same shape the field would take if it were merged. */
  readonly value: string;
  readonly valueRaw?: string | null | undefined;
  readonly sourceUrl: string;
  readonly origin: EnrichmentOrigin;
  readonly confidence: number;
  readonly rule: string;
  readonly reason: string;
  /** JSON. The signals the verdict was reached on. */
  readonly evidence: string;
  readonly runId?: number | null | undefined;
  readonly seenAt?: Date | undefined;
}

export interface SuggestionResult {
  readonly id: number;
  /** False when the same (lead, kind, value) was already queued. */
  readonly created: boolean;
}

/**
 * Queue a suggestion, or refresh the one already queued.
 *
 * A re-run that reads the same page again must not re-open a suggestion a
 * reviewer has already rejected, so an existing row keeps its `status` and its
 * resolution and only moves `last_seen_at` and the evidence forward.
 */
export function recordSuggestion(db: Db, input: SuggestionInput): SuggestionResult {
  const at = input.seenAt ?? new Date();
  const existing = db
    .select({ id: enrichmentSuggestions.id })
    .from(enrichmentSuggestions)
    .where(
      and(
        eq(enrichmentSuggestions.leadId, input.leadId),
        eq(enrichmentSuggestions.kind, input.kind),
        eq(enrichmentSuggestions.value, input.value),
      ),
    )
    .get();

  if (existing) {
    db.update(enrichmentSuggestions)
      .set({
        confidence: input.confidence,
        rule: input.rule,
        reason: input.reason,
        evidence: input.evidence,
        sourceUrl: input.sourceUrl,
        origin: input.origin,
        runId: input.runId ?? null,
        lastSeenAt: at,
      })
      .where(eq(enrichmentSuggestions.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }

  const row = db
    .insert(enrichmentSuggestions)
    .values({
      leadId: input.leadId,
      kind: input.kind,
      value: input.value,
      valueRaw: input.valueRaw ?? null,
      sourceUrl: input.sourceUrl,
      origin: input.origin,
      confidence: input.confidence,
      rule: input.rule,
      reason: input.reason,
      evidence: input.evidence,
      runId: input.runId ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .returning({ id: enrichmentSuggestions.id })
    .get();
  return { id: row.id, created: true };
}

export interface PendingSuggestionOptions {
  readonly limit?: number | undefined;
  readonly leadId?: number | undefined;
  readonly status?: SuggestionStatus | undefined;
}

/**
 * The review queue: everything still pending, best evidence first.
 *
 * This is what the Stage 5 review UI lists next to the merge candidates.
 */
export function pendingSuggestions(
  db: Executor,
  options: PendingSuggestionOptions = {},
): EnrichmentSuggestion[] {
  const status = options.status ?? 'pending';
  const where =
    options.leadId === undefined
      ? eq(enrichmentSuggestions.status, status)
      : and(
          eq(enrichmentSuggestions.status, status),
          eq(enrichmentSuggestions.leadId, options.leadId),
        );

  const query = db
    .select()
    .from(enrichmentSuggestions)
    .where(where)
    .orderBy(desc(enrichmentSuggestions.confidence), enrichmentSuggestions.id);
  return options.limit === undefined ? query.all() : query.limit(options.limit).all();
}

/** Every suggestion ever raised for a lead, whatever its status. */
export function suggestionsForLead(db: Executor, leadId: number): EnrichmentSuggestion[] {
  return db
    .select()
    .from(enrichmentSuggestions)
    .where(eq(enrichmentSuggestions.leadId, leadId))
    .orderBy(desc(enrichmentSuggestions.confidence), enrichmentSuggestions.id)
    .all();
}

/**
 * Record a reviewer's decision.
 *
 * Accepting a suggestion does **not** write the value onto the lead — that is
 * the review UI's call to `upsertLead`, with the reviewer as the provenance.
 * Keeping the two apart means a rejected suggestion is remembered without this
 * function ever having had write access to the lead.
 */
export function resolveSuggestion(
  db: Db,
  id: number,
  status: Exclude<SuggestionStatus, 'pending'>,
  resolvedBy: string,
  at: Date = new Date(),
): void {
  db.update(enrichmentSuggestions)
    .set({ status, resolvedBy, resolvedAt: at })
    .where(eq(enrichmentSuggestions.id, id))
    .run();
}

/**
 * The (kind, value) pairs a reviewer has already rejected for a lead.
 *
 * The enrichment run reads this before it merges anything: a value a human
 * looked at and said no to must never be promoted by a later run that happened
 * to find one more corroborating signal.
 */
export function rejectedValues(db: Executor, leadId: number): ReadonlySet<string> {
  const rows = db
    .select({ kind: enrichmentSuggestions.kind, value: enrichmentSuggestions.value })
    .from(enrichmentSuggestions)
    .where(
      and(
        eq(enrichmentSuggestions.leadId, leadId),
        inArray(enrichmentSuggestions.status, ['rejected']),
      ),
    )
    .all();
  return new Set(rows.map((row) => `${row.kind}:${row.value}`));
}

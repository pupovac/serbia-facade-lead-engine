/**
 * The human decision layer — every write the review UI makes.
 *
 * One rule shapes all of it: **a human decision must never be silently
 * overwritten by a later crawl.** That is not a promise a component can keep,
 * so it is enforced here, in the layer the UI writes through, using three
 * mechanisms the data model already has:
 *
 * 1. **A reviewer is a source.** `manual-review` is a row in `sources`, so a
 *    value a human typed is a claim with provenance, exactly like a value a
 *    directory published — the same table, the same `first_seen_at`, the same
 *    `source_url`. There is no second, weaker path for human data.
 * 2. **`is_current` is the human's.** The claim a reviewer promotes carries
 *    `is_current`; a later crawl's differing value is recorded next to it as a
 *    conflict and never promoted, because `upsertLead` fills blanks and never
 *    clobbers a filled column.
 * 3. **Decisions are recorded, not just applied.** A merge writes `merge_log`
 *    with a snapshot and is reversible; a rejected pair and a rejected
 *    suggestion keep their status, so the next sweep does not re-ask a question
 *    a human has already answered.
 *
 * `src/lib/review/decisions.test.ts` asserts (1)–(3) against a re-run of the
 * crawl path. That test is the one this whole file exists for.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Executor } from '../db/repo.js';
import {
  getLead,
  getMergeCandidate,
  promoteFieldValue,
  recordMerge,
  releaseCandidatesFor,
  resolveMergeCandidate,
  revertMerge,
  upsertLead,
  upsertSource,
  type MergeResult,
} from '../db/repo.js';
import { resolveSuggestion } from '../db/suggestions.js';
import {
  type EnrichmentSuggestion,
  type Lead,
  type LeadFieldValue,
  type LeadStatus,
  type ProvenanceField,
  enrichmentSuggestions,
  leadFieldValues,
  leads,
  mergeCandidates,
} from '../db/schema.js';
import { normalizeCompanyName } from '../normalize/name.js';

/**
 * The reviewer's `sources.id`.
 *
 * A human is a source of record, not an exception to the provenance rule. The
 * row is `enabled = false` so the crawl orchestrator never tries to run an
 * adapter for it.
 */
export const REVIEWER_SOURCE_ID = 'manual-review';

/** `lead_*.source_url` for a human edit: where in the UI the decision was made. */
export function reviewerSourceUrl(leadId: number): string {
  return `internal://review/leads/${leadId}`;
}

/** `merge_log.actor` / `resolved_by` — `reviewer:<id>`, the vocabulary the schema documents. */
export function reviewerActor(reviewer: string): string {
  return reviewer.startsWith('reviewer:') ? reviewer : `reviewer:${reviewer}`;
}

/**
 * Make sure `manual-review` exists before a human write references it.
 *
 * `lead_field_values.source_id` is a foreign key, so this has to run before the
 * first edit on a database the reviewer has never written to — which is every
 * database restored from a crawl-only pilot dump.
 */
export function ensureReviewerSource(db: Db): void {
  upsertSource(db, {
    id: REVIEWER_SOURCE_ID,
    name: 'Manual review (human)',
    url: 'internal://review',
    category: 'human review',
    priority: 'high',
    hasContractors: true,
    hasStores: true,
    requiresJs: false,
    robotsAllows: null,
    enabled: false,
    notes:
      'A reviewer working in the Next.js review UI. Values carrying this source id were ' +
      'entered by a human and outrank anything a crawl claims for the same field.',
  });
}

/** The fields a reviewer may correct by hand. */
export const EDITABLE_FIELDS = [
  'name',
  'address',
  'city',
  'classification',
  'legal_form',
  'postal_code',
  'registration_number',
  'tax_id',
  'description',
  'opening_hours',
] as const satisfies readonly ProvenanceField[];
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface FieldEdit {
  readonly leadId: number;
  readonly field: EditableField;
  readonly value: string;
  /** Who decided. Stored as `reviewer:<id>` on the review note. */
  readonly reviewer: string;
  readonly at?: Date | undefined;
}

/**
 * Correct one field by hand.
 *
 * The value is written the same way a crawl writes one — through `upsertLead`,
 * with `manual-review` as the provenance — and then deliberately promoted with
 * `promoteFieldValue`. Two consequences follow, and both are the point:
 *
 * - The previous value is **not** destroyed. It stays in `lead_field_values`
 *   with the source that claimed it, and the lead detail page shows both.
 * - A later crawl cannot take the field back. `upsertLead` only fills blanks,
 *   so the crawl's differing value lands as a conflict with `is_current = false`
 *   while the human's claim keeps `is_current = true`.
 */
export function editLeadField(db: Db, edit: FieldEdit): void {
  const value = edit.value.trim();
  if (value === '') throw new Error('a field edit needs a value');

  const lead = getLead(db, edit.leadId);
  if (!lead) throw new Error(`lead ${edit.leadId} not found`);
  if (lead.mergedIntoId != null) {
    throw new Error(`lead ${edit.leadId} was merged into ${lead.mergedIntoId}; edit the survivor`);
  }

  ensureReviewerSource(db);
  const at = edit.at ?? new Date();
  const provenance = {
    sourceId: REVIEWER_SOURCE_ID,
    sourceUrl: reviewerSourceUrl(edit.leadId),
    seenAt: at,
  };

  // `upsertLead` derives the claim set from the input, so the edited field is
  // supplied and everything else is left at the stored value: only the changed
  // field produces a new claim.
  const name = edit.field === 'name' ? value : lead.name;
  upsertLead(
    db,
    {
      leadId: edit.leadId,
      name,
      nameNormalized: normalizeCompanyName(name).ascii,
      ...(edit.field === 'address' ? { address: value } : {}),
      ...(edit.field === 'city' ? { cityRaw: value } : {}),
      ...(edit.field === 'classification'
        ? { classification: value as Lead['classification'], classificationConfidence: 1 }
        : {}),
      ...(edit.field === 'legal_form' ? { legalForm: value } : {}),
      ...(edit.field === 'postal_code' ? { postalCode: value } : {}),
      ...(edit.field === 'registration_number' ? { registrationNumber: value } : {}),
      ...(edit.field === 'tax_id' ? { taxId: value } : {}),
      ...(edit.field === 'description' ? { description: value } : {}),
      ...(edit.field === 'opening_hours' ? { openingHours: value } : {}),
    },
    provenance,
    { matching: 'caller' },
  );

  promoteFieldValue(db, edit.leadId, edit.field, value);
  db.update(leads).set({ reviewedAt: at, updatedAt: at }).where(eq(leads.id, edit.leadId)).run();
}

/** Every field a human has decided, with the claim that carries the decision. */
export function humanFieldEdits(db: Executor, leadId: number): LeadFieldValue[] {
  return db
    .select()
    .from(leadFieldValues)
    .where(
      and(eq(leadFieldValues.leadId, leadId), eq(leadFieldValues.sourceId, REVIEWER_SOURCE_ID)),
    )
    .all();
}

/**
 * A human decision the stored `leads` column no longer agrees with.
 *
 * This is a live warning, not a formality: `applyGrading()` — the function
 * FUZZ-32's re-classification sweep calls — overwrites `leads.classification`
 * unconditionally, and it does not read `lead_field_values`. When that happens
 * the human's claim still carries `is_current`, so the divergence is
 * detectable, and the lead detail page says so out loud instead of quietly
 * showing the machine's answer.
 */
export function overriddenHumanEdits(db: Executor, leadId: number): LeadFieldValue[] {
  const lead = getLead(db, leadId);
  if (!lead) return [];
  const column: Partial<Record<ProvenanceField, string | null>> = {
    name: lead.name,
    legal_form: lead.legalForm,
    address: lead.address,
    postal_code: lead.postalCode,
    city: lead.cityRaw,
    classification: lead.classification,
    description: lead.description,
    opening_hours: lead.openingHours,
    registration_number: lead.registrationNumber,
    tax_id: lead.taxId,
  };
  return humanFieldEdits(db, leadId).filter(
    (claim) =>
      claim.isCurrent && column[claim.field] !== undefined && column[claim.field] !== claim.value,
  );
}

export interface StatusDecision {
  readonly leadId: number;
  readonly status: LeadStatus;
  readonly note?: string | null | undefined;
  readonly reviewer: string;
  readonly at?: Date | undefined;
}

/**
 * Record where a lead stands in the human loop.
 *
 * `leads.status`, `review_note` and `reviewed_at` are the three columns nothing
 * in the crawl path writes — neither `upsertLead` nor `applyGrading` touches
 * them — so a decision recorded here is safe by construction.
 *
 * `LEAD_STATUSES` has no `contacted` value, so "we called them" is recorded as
 * `approved` plus a dated note. See the FUZZ-25 comment: a `contacted` status
 * belongs in the schema and the schema is not this layer's to change.
 */
export function setLeadStatus(db: Db, decision: StatusDecision): void {
  const at = decision.at ?? new Date();
  const stamp = `${at.toISOString().slice(0, 10)} ${reviewerActor(decision.reviewer)}`;
  const note =
    decision.note == null || decision.note.trim() === ''
      ? `${stamp}: ${decision.status}`
      : `${stamp}: ${decision.note.trim()}`;

  db.update(leads)
    .set({ status: decision.status, reviewNote: note, reviewedAt: at, updatedAt: at })
    .where(eq(leads.id, decision.leadId))
    .run();
}

export interface PairDecision {
  readonly candidateId: number;
  readonly reviewer: string;
  readonly at?: Date | undefined;
}

export interface MergeDecision extends PairDecision {
  /** Which of the pair keeps the id. The other becomes a tombstone pointing at it. */
  readonly survivingLeadId: number;
}

/**
 * Merge a review-band pair, on a human's say-so.
 *
 * The whole decision is one transaction: the merge itself, the candidate's
 * resolution, and the release of any other pending pair that pointed at the
 * lead just merged away. Half of that landing would leave a queue that
 * disagrees with the lead table.
 *
 * `signal` is `manual` because the reviewer decided — the evidence the engine
 * weighed is preserved in `signal_value` and in the candidate row, but the
 * merge log must not claim a machine signal made a call a human made.
 */
export function mergePair(db: Db, decision: MergeDecision): MergeResult {
  const at = decision.at ?? new Date();
  const actor = reviewerActor(decision.reviewer);

  return db.$client.transaction(() => {
    const candidate = db
      .select()
      .from(mergeCandidates)
      .where(eq(mergeCandidates.id, decision.candidateId))
      .get();
    if (!candidate) throw new Error(`merge candidate ${decision.candidateId} not found`);
    if (candidate.status !== 'pending') {
      throw new Error(`merge candidate ${decision.candidateId} is already ${candidate.status}`);
    }
    if (
      decision.survivingLeadId !== candidate.leadAId &&
      decision.survivingLeadId !== candidate.leadBId
    ) {
      throw new Error(`lead ${decision.survivingLeadId} is not part of this pair`);
    }
    const mergedLeadId =
      decision.survivingLeadId === candidate.leadAId ? candidate.leadBId : candidate.leadAId;

    const result = recordMerge(db, {
      survivingLeadId: decision.survivingLeadId,
      mergedLeadId,
      signal: 'manual',
      signalValue: candidate.signalValue,
      score: candidate.score,
      signals: candidate.signals,
      actor,
      mergedAt: at,
    });

    resolveMergeCandidate(db, candidate.id, 'merged', {
      resolvedBy: actor,
      mergeLogId: result.mergeLogId,
      at,
    });
    // Any other pending pair naming the tombstone is stale; the next sweep
    // re-proposes it against the survivor, with the fuller record to judge.
    releaseCandidatesFor(db, mergedLeadId, at);
    return result;
  })();
}

/**
 * Reject a pair.
 *
 * The row keeps `rejected` for good: `upsertMergeCandidate` refuses to reopen a
 * resolved pair, which is what stops the next sweep re-proposing 347 pairs a
 * human has already worked through.
 */
export function rejectPair(db: Db, decision: PairDecision): void {
  const at = decision.at ?? new Date();
  resolveMergeCandidate(db, decision.candidateId, 'rejected', {
    resolvedBy: reviewerActor(decision.reviewer),
    at,
  });
}

/**
 * Undo a merge and put the pair back in the queue.
 *
 * `revertMerge` restores both leads from the snapshot, but the candidate row it
 * came from stays `merged` — and `upsertMergeCandidate` will not reopen a
 * resolved pair — so without this the un-merged pair would never be reviewable
 * again. Reopening belongs next to `resolveMergeCandidate` in `repo.ts`; it is
 * here because the review UI needs merge to be reversible today.
 */
export function undoMerge(db: Db, mergeLogId: number, reviewer: string, note?: string): void {
  const actor = reviewerActor(reviewer);
  db.$client.transaction(() => {
    revertMerge(db, mergeLogId, note ?? `reverted by ${actor}`);
    db.update(mergeCandidates)
      .set({ status: 'pending', resolvedBy: null, resolvedAt: null, mergeLogId: null })
      .where(eq(mergeCandidates.mergeLogId, mergeLogId))
      .run();
  })();
}

export interface SuggestionDecision {
  readonly suggestionId: number;
  readonly reviewer: string;
  readonly at?: Date | undefined;
}

/**
 * Accept an enrichment finding: write the value onto the lead, then record the
 * decision.
 *
 * `resolveSuggestion` deliberately has no write access to the lead, so applying
 * the value is this function's job — through `upsertLead` with the reviewer as
 * the provenance, which is the same path `editLeadField` uses and gives the
 * accepted value the same protection from a later crawl.
 */
export function acceptSuggestion(db: Db, decision: SuggestionDecision): EnrichmentSuggestion {
  const at = decision.at ?? new Date();
  const actor = reviewerActor(decision.reviewer);

  return db.$client.transaction(() => {
    const suggestion = db
      .select()
      .from(enrichmentSuggestions)
      .where(eq(enrichmentSuggestions.id, decision.suggestionId))
      .get();
    if (!suggestion) throw new Error(`suggestion ${decision.suggestionId} not found`);
    if (suggestion.status !== 'pending') {
      throw new Error(`suggestion ${decision.suggestionId} is already ${suggestion.status}`);
    }
    const lead = getLead(db, suggestion.leadId);
    if (!lead) throw new Error(`lead ${suggestion.leadId} not found`);

    ensureReviewerSource(db);
    const provenance = {
      sourceId: REVIEWER_SOURCE_ID,
      // The page the value was read at, not the review screen: a reviewer
      // accepting a finding is vouching for that page.
      sourceUrl: suggestion.sourceUrl,
      seenAt: at,
    };

    if (suggestion.kind === 'phone') {
      upsertLead(
        db,
        {
          leadId: lead.id,
          name: lead.name,
          nameNormalized: lead.nameNormalized,
          phones: [
            {
              e164: suggestion.value,
              raw: suggestion.valueRaw ?? suggestion.value,
              valid: true,
              confidence: suggestion.confidence,
            },
          ],
        },
        provenance,
        { matching: 'caller' },
      );
    } else if (suggestion.kind === 'address' || suggestion.kind === 'city') {
      editLeadField(db, {
        leadId: lead.id,
        field: suggestion.kind === 'address' ? 'address' : 'city',
        value: suggestion.valueRaw ?? suggestion.value,
        reviewer: decision.reviewer,
        at,
      });
    } else {
      upsertLead(
        db,
        {
          leadId: lead.id,
          name: lead.name,
          nameNormalized: lead.nameNormalized,
          contacts: [
            {
              kind: suggestion.kind,
              value: suggestion.value,
              valueRaw: suggestion.valueRaw ?? suggestion.value,
              valid: true,
              confidence: suggestion.confidence,
            },
          ],
        },
        provenance,
        { matching: 'caller' },
      );
    }

    resolveSuggestion(db, suggestion.id, 'accepted', actor, at);
    return { ...suggestion, status: 'accepted' as const, resolvedBy: actor, resolvedAt: at };
  })();
}

/**
 * Reject an enrichment finding.
 *
 * `rejectedValues()` is read by the enrichment run before it merges anything,
 * so a value a human said no to is never promoted by a later run that happened
 * to find one more corroborating signal.
 */
export function rejectSuggestion(db: Db, decision: SuggestionDecision): void {
  resolveSuggestion(
    db,
    decision.suggestionId,
    'rejected',
    reviewerActor(decision.reviewer),
    decision.at ?? new Date(),
  );
}

/** Leads a human has decided on — the audit surface for "what did we change". */
export function reviewedLeads(db: Executor): Lead[] {
  return db
    .select()
    .from(leads)
    .where(and(isNull(leads.mergedIntoId), isNotNull(leads.reviewedAt)))
    .all();
}

export { getMergeCandidate };

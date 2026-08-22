/**
 * Re-classify leads that are already in the database.
 *
 * Two things live here, and they exist for the same reason: the classifier is
 * a pure function over text, and a stored lead is not text. Something has to
 * rebuild the `ClassificationInput` from what the database kept.
 *
 * **Rebuild from every source, not from the lead row.** `leads.description`
 * holds one description; a lead five directories agree on has five, plus five
 * category lists, and the categories are stored *only* inside
 * `raw_records.payload`. Classifying a merged lead off its own row therefore
 * reads it on a fraction of its own evidence — the same "merge, never delete"
 * rule the merge engine follows, applied to the text the classifier sees.
 *
 * **Re-classification is a first-class, repeatable operation.** A signal-table
 * change is worth exactly what it moves on a real corpus, so measuring that has
 * to be a committed code path (`scripts/reclassify.ts`) rather than a query
 * somebody typed once into a shell.
 */
import { eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { leadContactClaims, leadSources, leads, rawRecords } from '../db/index.js';
import { classifyLead } from './classify.js';
import type { ClassificationInput, ClassificationResult, LeadClassification } from './types.js';

/**
 * The adapter payload as it was stored, plus the wrapper the enrichment crawler
 * puts around it. Everything is optional: this is JSON off the disk, not a
 * validated boundary — the zod validation happened when the record was ingested.
 */
interface StoredPayload {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly categories?: unknown;
  readonly website?: unknown;
  /** `website-enrichment` stores `{ raw, verdict }` rather than the lead itself. */
  readonly raw?: StoredPayload;
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function unwrap(payload: StoredPayload): StoredPayload {
  return payload.raw === undefined ? payload : payload.raw;
}

/** Distinct, in first-seen order. Order is stable so the evidence trail is too. */
function pushUnique(into: string[], value: string | undefined): void {
  if (value !== undefined && !into.includes(value)) into.push(value);
}

/** Every raw payload behind a lead, oldest first. */
function leadPayloads(db: Db, leadId: number): StoredPayload[] {
  const rows = db
    .select({ payload: rawRecords.payload })
    .from(leadSources)
    .innerJoin(rawRecords, eq(rawRecords.id, leadSources.rawRecordId))
    .where(eq(leadSources.leadId, leadId))
    .orderBy(leadSources.firstSeenAt, leadSources.id)
    .all();

  const payloads: StoredPayload[] = [];
  for (const row of rows) {
    try {
      payloads.push(unwrap(JSON.parse(row.payload) as StoredPayload));
    } catch {
      // A payload that no longer parses is a bug in whoever wrote it, not a
      // reason to refuse to classify the lead. Skip it and keep the rest.
    }
  }
  return payloads;
}

/**
 * Everything the sources ever said about one lead, as classifier input.
 *
 * The website comes from `lead_contacts` rather than the payload: the contact
 * extractor already decided which of the links on a listing is the business's
 * own site, and that decision should not be made twice.
 */
export function leadClassificationInput(db: Db, leadId: number): ClassificationInput | undefined {
  const lead = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (lead === undefined) return undefined;

  const descriptions: string[] = [];
  pushUnique(descriptions, textOf(lead.description));
  const categories: string[] = [];

  for (const payload of leadPayloads(db, leadId)) {
    pushUnique(descriptions, textOf(payload.description));
    if (Array.isArray(payload.categories)) {
      for (const category of payload.categories) pushUnique(categories, textOf(category));
    }
  }

  const website = leadContactClaims(db, leadId).find((contact) => contact.kind === 'website');

  return {
    name: lead.name,
    ...(descriptions.length === 0 ? {} : { description: descriptions.join('\n') }),
    ...(categories.length === 0 ? {} : { categories }),
    ...(website === undefined ? {} : { website: website.value }),
  };
}

/** One lead, before and after. */
export interface ReclassifiedLead {
  readonly leadId: number;
  readonly name: string;
  readonly before: LeadClassification;
  readonly after: LeadClassification;
  readonly result: ClassificationResult;
}

export interface ReclassifyReport {
  /** Active leads considered — tombstones of merged-away rows are skipped. */
  readonly total: number;
  readonly before: Readonly<Record<LeadClassification, number>>;
  readonly after: Readonly<Record<LeadClassification, number>>;
  /** `FROM→TO` → count, for every lead whose label moved. */
  readonly transitions: Readonly<Record<string, number>>;
  readonly changed: readonly ReclassifiedLead[];
  /** Every lead's new label, changed or not — the input to a precision sample. */
  readonly all: readonly ReclassifiedLead[];
}

const EMPTY_COUNTS = (): Record<LeadClassification, number> => ({
  FACADE_CONTRACTOR: 0,
  CONSTRUCTION_MATERIAL_STORE: 0,
  BOTH: 0,
  UNKNOWN: 0,
});

/**
 * Re-classify every active lead and report what moved.
 *
 * Pure with respect to the database: nothing is written. Writing the new label
 * back is `regradeLead`'s job, because a new label changes the lead score too
 * and those two must not drift apart.
 */
export function reclassifyCorpus(
  db: Db,
  options: { readonly leadIds?: readonly number[] } = {},
): ReclassifyReport {
  const rows =
    options.leadIds === undefined
      ? db
          .select({ id: leads.id, name: leads.name, classification: leads.classification })
          .from(leads)
          .where(isNull(leads.mergedIntoId))
          .orderBy(leads.id)
          .all()
      : db
          .select({ id: leads.id, name: leads.name, classification: leads.classification })
          .from(leads)
          .where(inArray(leads.id, [...options.leadIds]))
          .orderBy(leads.id)
          .all();

  const before = EMPTY_COUNTS();
  const after = EMPTY_COUNTS();
  const transitions: Record<string, number> = {};
  const all: ReclassifiedLead[] = [];
  const changed: ReclassifiedLead[] = [];

  for (const row of rows) {
    const input = leadClassificationInput(db, row.id);
    if (input === undefined) continue;
    const result = classifyLead(input);
    const entry: ReclassifiedLead = {
      leadId: row.id,
      name: row.name,
      before: row.classification,
      after: result.label,
      result,
    };
    before[row.classification] += 1;
    after[result.label] += 1;
    all.push(entry);
    if (entry.before !== entry.after) {
      changed.push(entry);
      const key = `${entry.before}→${entry.after}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
  }

  return { total: all.length, before, after, transitions, changed, all };
}

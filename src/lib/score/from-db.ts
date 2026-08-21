/**
 * Turn what the repository already returns into a `ScoreInput`.
 *
 * The scorer stays free of Drizzle and the repository stays free of scoring
 * rules; this is the one place that knows both shapes. `repo.distinctPhones`
 * and `repo.leadContactClaims` already collapse per-source claims, so nothing
 * here re-derives them.
 */
import { decidingNet } from '../classify/classify.js';
import type { ClassificationResult } from '../classify/types.js';
import type { CityMatch } from '../normalize/city.js';
import type { ContactKind, Lead, LeadContact, LeadSource } from '../db/schema.js';
import type { DistinctPhone } from '../db/repo.js';
import type { ScoreInput } from './types.js';

/** `lead_contacts.kind` values that count as a social profile. */
const SOCIAL_KINDS: ReadonlySet<ContactKind> = new Set([
  'facebook',
  'instagram',
  'google_maps',
  'linkedin',
  'youtube',
]);

export interface ScoreSources {
  readonly lead: Lead;
  readonly phones: readonly DistinctPhone[];
  readonly contacts: readonly LeadContact[];
  /** `repo.leadSourceRows(db, leadId)`, or just the distinct source ids. */
  readonly sources: readonly LeadSource[] | readonly string[];
  /**
   * The city match, when the caller still has it. Without it the city
   * component falls back to `leads.city_id`, which is scored as a plain
   * resolved city rather than a confident one.
   */
  readonly city?: Pick<CityMatch, 'confidence' | 'matchedVia'> | null | undefined;
  readonly now?: Date | undefined;
}

/**
 * Confidence to assume when a lead row carries a `city_id` but the caller no
 * longer has the `CityMatch` that produced it. Deliberately below an exact
 * match: the row does not say how the city was resolved, and treating an
 * unknown provenance as certain is how a landline guess becomes a fact.
 */
export const PERSISTED_CITY_CONFIDENCE = 0.8;

/**
 * The net evidence behind the stored label, recovered from
 * `leads.classification_evidence`.
 *
 * The column is written by the pipeline and by every re-grade, but it is
 * nullable and predates FUZZ-37 on some rows, so a miss is normal rather than
 * an error: `scoreRelevance` falls back to the confidence when this returns
 * `null`. A malformed JSON blob is treated the same way — a parser bug in a
 * derived column must not stop a lead from being scored.
 */
export function storedEvidenceNet(evidence: string | null): number | null {
  if (evidence === null || evidence === '') return null;
  try {
    const parsed = JSON.parse(evidence) as ClassificationResult;
    if (typeof parsed?.label !== 'string') return null;
    return decidingNet(parsed);
  } catch {
    return null;
  }
}

export function toScoreInput({
  lead,
  phones,
  contacts,
  sources,
  city,
  now,
}: ScoreSources): ScoreInput {
  const sourceIds = sources.map((s) => (typeof s === 'string' ? s : s.sourceId));
  const resolvedCity =
    city ??
    (lead.cityId === null
      ? null
      : { confidence: PERSISTED_CITY_CONFIDENCE, matchedVia: 'exact' as const });

  return {
    phones: phones.map((p) => ({ e164: p.e164, type: p.type, valid: p.valid })),
    emails: contacts.filter((c) => c.kind === 'email' && c.valid).map((c) => c.value),
    websites: contacts.filter((c) => c.kind === 'website' && c.valid).map((c) => c.value),
    socials: contacts.filter((c) => SOCIAL_KINDS.has(c.kind) && c.valid).map((c) => c.value),
    city: resolvedCity,
    classification: {
      label: lead.classification,
      confidence: lead.classificationConfidence,
      evidenceNet: storedEvidenceNet(lead.classificationEvidence),
    },
    sourceIds,
    lastSeenAt: lead.lastSeenAt,
    ...(now === undefined ? {} : { now }),
  };
}

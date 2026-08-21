/**
 * The one place that turns a classification and a score into the columns
 * `applyGrading` writes.
 *
 * Three call sites re-grade a lead — the scraper pipeline, the enrichment
 * applier and `regradeLead` — and every one of them has to write the same six
 * columns in the same way. Before FUZZ-37 there were two of them and they
 * already disagreed about whether `classification_evidence` was worth keeping.
 * With five columns and a derived seventh, three hand-written copies of this
 * object is a bug waiting for the fourth caller.
 */
import type { AdjacentIndustry, LeadClassification } from '../db/schema.js';
import type { GradingInput } from '../db/repo.js';
import type { LeadScore } from './types.js';

/** The label half of a grading — either a fresh `ClassificationResult` or a stored one. */
export interface GradedClassification {
  readonly label: LeadClassification;
  readonly confidence: number;
  /** `JSON.stringify` of the full `ClassificationResult`, or the blob already stored. */
  readonly evidence?: string | null | undefined;
  /** Only meaningful with `OUT_OF_SCOPE`; anything else clears the column. */
  readonly industry?: AdjacentIndustry | null | undefined;
}

export function toGrading(classification: GradedClassification, score: LeadScore): GradingInput {
  return {
    classification: classification.label,
    classificationConfidence: classification.confidence,
    classificationEvidence: classification.evidence ?? null,
    // A lead that stopped being out of scope must stop carrying the industry
    // that put it there, or the audit trail outlives the decision it explains.
    classificationIndustry:
      classification.label === 'OUT_OF_SCOPE' ? (classification.industry ?? null) : null,
    relevanceScore: score.relevance,
    relevanceBreakdown: JSON.stringify(score.relevanceComponents),
    contactabilityScore: score.contactability,
    scoreBreakdown: JSON.stringify(score.components),
    leadScore: score.score,
  };
}

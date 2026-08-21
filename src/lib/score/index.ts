/**
 * The two lead scores — **relevance** (is this a lead for us?) and
 * **contactability** (how much contact data do we hold?) — each with the
 * breakdown that explains it, plus the derived `lead_score` the export sorts
 * on. See `weights.ts` for why they are two numbers and not one.
 */
export { scoreLead, scoreRelevance, deriveLeadScore } from './score.js';
export { toScoreInput, storedEvidenceNet, PERSISTED_CITY_CONFIDENCE } from './from-db.js';
export type { ScoreSources } from './from-db.js';
export { toGrading } from './grading.js';
export type { GradedClassification } from './grading.js';
export {
  ADDITIONAL_PHONE_CAP,
  CLASSIFICATION_RELEVANCE,
  CONFIDENCE_CEILING,
  CONFIDENCE_FLOOR,
  CONTACTABILITY_WEIGHTS,
  CORROBORATION_CAP,
  EVIDENCE_FULL_NET,
  MAX_SCORE,
  NO_PHONE_CEILING,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  RELEVANCE_WEIGHTS,
} from './weights.js';
export type { ContactabilityWeights, RelevanceWeights } from './weights.js';
export type * from './types.js';

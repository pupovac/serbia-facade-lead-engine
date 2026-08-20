/**
 * The lead score — data completeness and relevance, 0–100, with the breakdown
 * that explains it.
 */
export { scoreLead } from './score.js';
export { toScoreInput, PERSISTED_CITY_CONFIDENCE } from './from-db.js';
export type { ScoreSources } from './from-db.js';
export {
  ADDITIONAL_PHONE_CAP,
  CLASSIFICATION_RELEVANCE,
  CORROBORATION_CAP,
  MAX_SCORE,
  NO_PHONE_CEILING,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  SCORE_WEIGHTS,
} from './weights.js';
export type { ScoreWeights } from './weights.js';
export type * from './types.js';

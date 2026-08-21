/**
 * Lead classification. Which of the two buyer groups a business belongs to,
 * and the evidence for saying so.
 */
export { assertClassification, type AssertedClassificationInput } from './asserted.js';
export { classifyLead } from './classify.js';
export {
  ASSORTMENT_BONUS,
  ASSORTMENT_GATE,
  DECISION_THRESHOLD,
  FIELD_WEIGHTS,
  SIGNALS,
  SIGNALS_BY_ID,
} from './signals.js';
export type * from './types.js';

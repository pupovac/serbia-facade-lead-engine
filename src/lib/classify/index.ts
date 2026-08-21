/**
 * Lead classification. Which of the two buyer groups a business belongs to,
 * and the evidence for saying so.
 */
export { assertClassification, type AssertedClassificationInput } from './asserted.js';
export { classifyLead, decidingNet } from './classify.js';
export {
  ASSORTMENT_BONUS,
  NO_ASSORTMENT_DISCOUNT,
  ASSORTMENT_GATE,
  DECISION_THRESHOLD,
  FIELD_WEIGHTS,
  SIGNALS,
  SIGNALS_BY_ID,
} from './signals.js';
export type * from './types.js';

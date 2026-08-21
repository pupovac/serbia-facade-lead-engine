/**
 * The review UI's read models and its human decision layer.
 *
 * `app/` imports from here and nowhere else in the data layer: the App Router
 * has no Drizzle query and no SQL of its own. Everything below is a plain
 * synchronous function over an `Executor`, so a server component calls it
 * directly and a test calls it against an in-memory database.
 *
 * The split is deliberate:
 *
 * - `leads.ts`, `dashboard.ts`, `detail.ts` — reads. Filtering, sorting,
 *   pagination and every aggregate happen in the database.
 * - `decisions.ts` — writes. Provenance, reversibility and "a crawl never
 *   overwrites a human" live there, not in a server action.
 */
export * from './types.js';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, activeLeadFor, leadFacets, listLeads } from './leads.js';
export {
  dashboardStats,
  growth,
  municipalityCoverage,
  sourceYield,
  type ClassificationCount,
  type DashboardStats,
  type GrowthPoint,
  type MunicipalityCoverage,
  type SourceYield,
} from './dashboard.js';
export { isBrowsableSourceUrl, leadDetail, mergeQueue, suggestionQueue } from './detail.js';
export {
  EDITABLE_FIELDS,
  REVIEWER_SOURCE_ID,
  acceptSuggestion,
  editLeadField,
  ensureReviewerSource,
  humanFieldEdits,
  mergePair,
  overriddenHumanEdits,
  rejectPair,
  rejectSuggestion,
  reviewerActor,
  reviewerSourceUrl,
  reviewedLeads,
  setLeadStatus,
  undoMerge,
  type EditableField,
  type FieldEdit,
  type MergeDecision,
  type PairDecision,
  type StatusDecision,
  type SuggestionDecision,
} from './decisions.js';

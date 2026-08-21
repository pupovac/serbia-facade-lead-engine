/**
 * The shapes the review UI reads.
 *
 * These are read models, not table rows: a lead in the list carries its phone
 * count and its corroborating-source count because that is what a salesperson
 * scans for, and computing either one per row in a React component would be a
 * query per row over a table that is meant to hold tens of thousands.
 */
import type {
  EnrichmentSuggestion,
  Lead,
  LeadClassification,
  LeadContact,
  LeadFieldValue,
  LeadSource,
  LeadStatus,
  MergeCandidate,
  MergeLogEntry,
  Source,
} from '../db/schema.js';
import type { DistinctPhone, FieldConflict } from '../db/repo.js';

/** What a lead-list row shows. One row per business, no matter how many claims back it. */
export interface LeadListRow {
  readonly id: number;
  readonly name: string;
  readonly cityRaw: string | null;
  readonly cityId: string | null;
  readonly municipalityId: string | null;
  readonly classification: LeadClassification;
  readonly classificationConfidence: number | null;
  readonly leadScore: number;
  readonly status: LeadStatus;
  /** Distinct valid numbers. Invalid claims are excluded — see `validPhones`. */
  readonly phoneCount: number;
  /** The number to dial first: the primary claim, else a mobile, else the first seen. */
  readonly primaryPhone: string | null;
  /** `064 123 4567` — what a Serbian salesperson reads. */
  readonly primaryPhoneNational: string | null;
  /** Distinct `sources.id` values that published this business. */
  readonly sourceCount: number;
  readonly hasWebsite: boolean;
  readonly hasEmail: boolean;
  readonly reviewedAt: Date | null;
  readonly lastSeenAt: Date;
}

export const LEAD_SORT_KEYS = ['score', 'name', 'city', 'lastSeen', 'firstSeen'] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

/** Every filter the list understands. All of them are applied in SQL. */
export interface LeadListQuery {
  /** Free text over the published name, the folded name key, the city and the phone digits. */
  readonly search?: string | undefined;
  readonly municipalityId?: string | undefined;
  readonly cityId?: string | undefined;
  /** Empty or absent means "every label" — never a baked-in list. */
  readonly classifications?: readonly LeadClassification[] | undefined;
  readonly status?: LeadStatus | undefined;
  readonly minScore?: number | undefined;
  /** `true` keeps only leads with at least one valid number; `false` only those without. */
  readonly hasPhone?: boolean | undefined;
  /** A `sources.id` that has seen this lead. */
  readonly sourceId?: string | undefined;
  readonly sort?: LeadSortKey | undefined;
  readonly direction?: SortDirection | undefined;
  /** 1-based. Out-of-range pages clamp to the last one. */
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface LeadListPage {
  readonly rows: readonly LeadListRow[];
  /** Rows matching the filter, not rows on this page. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

/** A filter value that exists in the data, with the number of leads behind it. */
export interface Facet {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The filter vocabulary, read from the data.
 *
 * The classifier is still moving (FUZZ-32 re-classifies the corpus), so the
 * type filter must offer the labels that are actually stored rather than a list
 * baked into a component.
 */
export interface LeadFacets {
  readonly classifications: readonly Facet[];
  readonly statuses: readonly Facet[];
  readonly municipalities: readonly Facet[];
  readonly sources: readonly Facet[];
}

/** One source URL a business was seen at, with whether it is worth linking to. */
export interface SourceSighting extends LeadSource {
  readonly sourceName: string;
  /**
   * False for a URL that resolves to nothing a human can open — the Overture
   * extract's S3 object prefix is 1,638 of the pilot's leads. Rendering it as a
   * link promises a page that is not there.
   */
  readonly browsable: boolean;
}

/** Everything known about one business. */
export interface LeadDetail {
  readonly lead: Lead;
  /** The survivor, when this id is a merge tombstone. */
  readonly resolvesTo: Lead | null;
  readonly phones: readonly DistinctPhone[];
  /** Claims `libphonenumber-js` rejected — department labels and the like. Shown apart. */
  readonly invalidPhones: readonly DistinctPhone[];
  readonly contacts: readonly LeadContact[];
  readonly sightings: readonly SourceSighting[];
  readonly fieldClaims: readonly LeadFieldValue[];
  readonly conflicts: readonly FieldConflict[];
  readonly mergeHistory: readonly MergeLogEntry[];
  readonly suggestions: readonly EnrichmentSuggestion[];
  readonly sourceCount: number;
}

/** One side of a review-band pair, with enough to judge it without opening the lead. */
export interface CandidateSide {
  readonly lead: Lead;
  readonly phones: readonly DistinctPhone[];
  readonly contacts: readonly LeadContact[];
  readonly sightings: readonly SourceSighting[];
  readonly sourceCount: number;
}

export interface MergeCandidatePair {
  readonly candidate: MergeCandidate;
  readonly a: CandidateSide;
  readonly b: CandidateSide;
}

export interface MergeQueuePage {
  readonly pairs: readonly MergeCandidatePair[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

/** A pending enrichment finding, with the lead it would be written onto. */
export interface SuggestionWithLead {
  readonly suggestion: EnrichmentSuggestion;
  readonly lead: Lead;
  /** Numbers already on the lead — so a reviewer can see what the finding adds. */
  readonly existingPhones: readonly string[];
  readonly existingContacts: readonly LeadContact[];
}

export interface SuggestionQueuePage {
  readonly items: readonly SuggestionWithLead[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

export type { Source };

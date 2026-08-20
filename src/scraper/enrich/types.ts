/**
 * The shapes the enrichment crawler passes between its four steps: pick a
 * target, fetch a page, decide whether the page is the same business, apply
 * what it found.
 *
 * Everything here is data. The rules are in `confidence.ts`, the numbers are in
 * `thresholds.ts`, and neither of them touches the network or the database —
 * which is what makes the decision that can poison the sales list testable
 * without either.
 */
import type { ContactInput, EnrichmentOrigin, SuggestionKind } from '@/lib/db';
import type { LeadRecord, MatchScore, Signal } from '@/lib/dedup';
import type { SocialNetwork } from '@/lib/contact';

export type { EnrichmentOrigin };

/**
 * The three outcomes.
 *
 * `suggest` is not a hedge and not a failure to decide — it is the outcome that
 * keeps the other two honest. Without it, every "probably the same business"
 * has to be either merged (and one wrong merge writes a competitor's phone onto
 * a lead, silently) or discarded (and most of what enrichment is for is thrown
 * away).
 */
export type EnrichmentTier = 'merge' | 'suggest' | 'discard';

/**
 * Which of the high-value facts a lead is missing.
 *
 * `phone` first, always: the phone is the deliverable, and a lead without one
 * is capped at `NO_PHONE_CEILING` however complete the rest of it is.
 */
export type EnrichableField = 'phone' | 'email' | 'website' | 'social' | 'address' | 'city';

/** A lead worth spending requests on, and what filling its blanks would be worth. */
export interface EnrichmentTarget {
  readonly leadId: number;
  /** As published. Used for the search query and shown in the log. */
  readonly name: string;
  readonly cityName: string | null;
  /** The comparable record — what `scoreMatch` weighs a candidate page against. */
  readonly record: LeadRecord;
  /** Canonical `https://…` URLs the lead already carries. Empty means the search path. */
  readonly websites: readonly string[];
  readonly missing: readonly EnrichableField[];
  /**
   * Points on the 0–100 lead score that filling every missing field could add,
   * including the removal of the no-phone ceiling. The ordering key: the run
   * spends its request budget where it buys the most.
   */
  readonly potentialGain: number;
}

/** One phone number a page published, with the evidence for how it was published. */
export interface EvidencePhone {
  readonly e164: string;
  readonly raw: string;
  /** `tel-link`, `json-ld`, `microdata`, `meta`, `data-attribute`, `text`. */
  readonly origin: string;
  readonly type: import('@/lib/db').PhoneType;
}

export interface EvidenceSocial {
  readonly network: SocialNetwork;
  readonly url: string;
}

/**
 * What one fetched page said about a business.
 *
 * Deliberately not a lead and not a `RawLead`: it is the page's claims, before
 * anything has decided whose claims they are. `candidateRecord` is the same
 * content in the shape `scoreMatch` compares, so the confidence rules never
 * re-derive it.
 */
export interface PageEvidence {
  /** The URL asked for. */
  readonly url: string;
  /** Where the response came from after redirects — the provenance that is written. */
  readonly finalUrl: string;
  /** `<title>`, `og:site_name` or the `<h1>`, whichever the page actually has. */
  readonly businessName: string | null;
  readonly phones: readonly EvidencePhone[];
  readonly emails: readonly string[];
  /** Canonical site URL as the page declares it — usually its own origin. */
  readonly website: string | null;
  readonly websiteDomain: string | null;
  readonly socials: readonly EvidenceSocial[];
  /** schema.org `PostalAddress`, or a line the page labelled `Adresa:`. */
  readonly address: string | null;
  /**
   * How the address was published. `structured` is markup the owner emitted and
   * is allowed to corroborate a merge; `labelled` is prose behind an `Adresa:`
   * label and is not. See `page.ts`.
   */
  readonly addressGrade: 'structured' | 'labelled' | null;
  readonly postalCode: string | null;
  /** The place string the address or the JSON-LD stated, before it was resolved. */
  readonly cityRaw: string | null;
  readonly cityId: string | null;
  readonly municipalityId: string | null;
  /**
   * How many distinct businesses the page looks like it describes.
   *
   * A directory's category page is a healthy 200 full of other companies'
   * phone numbers, and reading one as "the business" is the single most
   * damaging thing this crawler could do. See `thresholds.ts`.
   */
  readonly businessesOnPage: number;
  /**
   * The emails, the website and the social profiles as `lead_contacts` claims,
   * already through `src/lib/contact`'s `toContactInputs`.
   *
   * Carried rather than re-derived because the extractors are not idempotent
   * under a changed `sourceDomain`: running them a second time with the page's
   * own host would reject the business's own address as directory-owned. See
   * `page.ts`.
   */
  readonly contacts: readonly ContactInput[];
  /** The page as `scoreMatch` compares it. */
  readonly candidateRecord: LeadRecord;
}

/**
 * Why a verdict came out the way it did. Every id is greppable in
 * `confidence.ts` and stored on the suggestion row, so a queued finding can be
 * argued with rather than merely read.
 */
export type ConfidenceRuleId =
  /* -- merge ------------------------------------------------------------- */
  /** The page is on a domain the lead already carries. Ownership, not inference. */
  | 'own_site'
  /** A decisive identifier is shared: phone, website domain, email, registration number. */
  | 'decisive_identifier'
  /** Name match in the same place, with a shared address or social profile behind it. */
  | 'name_city_corroborated'
  /* -- suggest ----------------------------------------------------------- */
  /** A strong name match in the same place and nothing corroborating it. */
  | 'name_city_alone'
  /** Corroboration without a name match — same address, different-looking name. */
  | 'corroboration_without_name'
  /** A decisive signal the quarantine has disarmed. */
  | 'quarantined_identifier'
  /* -- discard ----------------------------------------------------------- */
  /** The page describes more businesses than one page about one business ever does. */
  | 'page_is_a_listing'
  /** A known directory or social platform, reached by search. Not a business's own page. */
  | 'origin_is_a_directory'
  /** The lead has no city, so a name can never be corroborated by place. */
  | 'lead_has_no_place'
  /** Nothing on the page connects it to this lead. */
  | 'no_connection'
  /** The page yielded no contact detail worth attaching. */
  | 'nothing_to_add';

/** What the confidence rules are handed. Pure input — no database, no clock. */
export interface ConfidenceInput {
  readonly lead: LeadRecord;
  readonly page: PageEvidence;
  readonly origin: EnrichmentOrigin;
  /** Which decisive values have lost the right to decide. Defaults to none. */
  readonly quarantine?: import('@/lib/dedup').Quarantine | undefined;
}

/** What the confidence rules return. */
export interface ConfidenceVerdict {
  readonly tier: EnrichmentTier;
  /** 0–1, clamped into the band the rule chose. Orders the review queue. */
  readonly confidence: number;
  readonly rule: ConfidenceRuleId;
  /** One sentence, aimed at the human reading the queue. */
  readonly reason: string;
  /** The signals that carried the verdict, from `scoreMatch`. */
  readonly signals: readonly Signal[];
  /** The full underlying comparison, kept so a merge can be re-argued later. */
  readonly match: MatchScore;
}

/** One value the crawler proposes to attach to a lead. */
export interface EnrichmentFinding {
  readonly kind: SuggestionKind;
  readonly value: string;
  readonly valueRaw: string | null;
  readonly field: EnrichableField;
}

/** Why a candidate page was thrown away. Counted and reported, never silent. */
export type RejectionReason =
  | ConfidenceRuleId
  | 'robots_disallowed'
  | 'fetch_failed'
  | 'search_unavailable'
  | 'already_rejected_by_a_reviewer';

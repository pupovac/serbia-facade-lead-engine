/**
 * Shared types for the email, website and social extractors.
 *
 * Every extractor returns what it kept AND what it dropped, because the
 * validation report has to be able to explain a missing email to a human.
 */

/** A scraped anchor. Adapters may pass a bare href string instead. */
export interface LinkCandidate {
  readonly href: string;
  /** The anchor text, whitespace-collapsed. `www.bimax.rs` and `Web sajt` are both strong signals. */
  readonly text?: string;
  readonly rel?: string;
}

export type LinkInput = string | LinkCandidate;

/** How an address was hidden from naive scrapers before we read it. */
export type EmailObfuscation =
  'none' | 'mailto' | 'spaced' | 'at-word' | 'html-entity' | 'cloudflare';

export interface ExtractedEmail {
  /** Canonical, lower-cased. This is the deduplication key. */
  readonly email: string;
  /**
   * The fragment the address came from, for auditing: the `mailto:` href, the
   * obfuscated text, or the `data-cfemail` attribute. Entity-encoded addresses
   * report their decoded text, since the entities are not the address.
   */
  readonly raw: string;
  readonly localPart: string;
  readonly domain: string;
  /** `gmail.com`, `beotel.rs`, `firma.co.rs` — the merge key when the domain is a business domain. */
  readonly registrableDomain: string;
  readonly obfuscation: EmailObfuscation;
  /** `info@`, `prodaja@`, `kontakt@` — kept, but it is not a person. */
  readonly role: boolean;
  /**
   * A free mailbox or an ISP mailbox (`gmail.com`, `beotel.rs`, `sbb.rs`).
   * Sole traders use these constantly, so it is never a reason to drop the
   * address — but the domain must never be used as a business identity key.
   */
  readonly freeProvider: boolean;
}

/** Why a website candidate won. */
export type WebsiteEvidence =
  | 'anchor-text-keyword'
  | 'anchor-text-is-domain'
  | 'mailto-domain'
  | 'only-external-link'
  | 'ranked-first';

export interface NormalizedWebsite {
  /** Canonical form: `https://firma.rs`. Idempotent, and the top-tier dedup key after the phone. */
  readonly url: string;
  /** Host without `www.`: `firma.rs`. */
  readonly domain: string;
  /** `firma.rs` for `shop.firma.rs` — what dedup actually compares. */
  readonly registrableDomain: string;
  /** The href exactly as scraped. */
  readonly raw: string;
  /** The scheme the page actually published, which the canonical form discards. */
  readonly observedScheme: 'http' | 'https';
  /** A link shortener — the real host is only known after `resolveFinalWebsite`. */
  readonly shortener: boolean;
  readonly evidence: WebsiteEvidence;
}

export type SocialNetwork = 'facebook' | 'instagram' | 'googleMaps';

/** Which stable identifier we managed to read out of the URL decoration. */
export type SocialIdKind =
  'slug' | 'numeric_id' | 'handle' | 'place_id' | 'cid' | 'ftid' | 'short_link' | 'coordinates';

export interface SocialProfile {
  readonly network: SocialNetwork;
  /** The stable identifier, decoration stripped: a page slug, a handle, a place id. */
  readonly id: string;
  readonly idKind: SocialIdKind;
  /** Canonical URL rebuilt from the identifier. */
  readonly url: string;
  readonly raw: string;
}

export interface ExtractedSocials {
  readonly facebook?: SocialProfile;
  readonly instagram?: SocialProfile;
  readonly googleMaps?: SocialProfile;
}

/** One dropped value and the documented rule that dropped it. */
export interface Rejection {
  readonly value: string;
  readonly rule: RejectionRuleId;
  readonly detail?: string;
}

export type EmailRejectionRuleId =
  | 'email_empty_mailto'
  | 'email_invalid_syntax'
  | 'email_invalid_domain'
  | 'email_asset_filename'
  | 'email_placeholder'
  | 'email_noreply_mailbox'
  | 'email_directory_domain'
  | 'email_source_owned'
  | 'email_tracking_address';

export type WebsiteRejectionRuleId =
  | 'website_unparseable'
  | 'website_source_domain'
  | 'website_source_sibling'
  | 'website_known_directory'
  | 'website_social_network'
  | 'website_share_intent'
  | 'website_vendor_credit'
  | 'website_advertising_banner'
  | 'website_infrastructure'
  | 'website_asset_or_document'
  | 'website_ambiguous_link_farm';

export type SocialRejectionRuleId =
  | 'social_share_intent'
  | 'social_platform_root'
  | 'social_not_a_profile'
  | 'social_directory_profile'
  | 'social_no_stable_identifier';

export type RejectionRuleId = EmailRejectionRuleId | WebsiteRejectionRuleId | SocialRejectionRuleId;

export interface EmailOptions {
  /** The host the page was scraped from, e.g. `www.011info.com`. */
  readonly sourceDomain: string;
  /** Anchor hrefs to scan for `mailto:`, when the caller has parsed the HTML already. */
  readonly links?: readonly string[];
  /**
   * Addresses the source itself publishes on every listing — the directory's
   * own gmail account, which the domain comparison cannot see. Per-source, from
   * the adapter registry.
   */
  readonly sourceOwnedEmails?: readonly string[];
}

export interface WebsiteOptions {
  readonly sourceDomain: string;
}

export interface SocialOptions {
  /** Used to drop the directory's own Facebook page from every lead it lists. */
  readonly sourceDomain?: string;
  /** Explicit profile ids or URLs the source owns, when the brand name does not match its domain. */
  readonly sourceOwnedProfiles?: readonly string[];
}

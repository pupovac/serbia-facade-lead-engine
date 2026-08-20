import type { RejectionRuleId } from './types.js';

/**
 * The catalogue of every reason a contact value is dropped.
 *
 * The validation report renders this table, so a human looking at "3 emails
 * dropped" can see which rule fired and why it exists. Adding a rejection
 * anywhere in this directory means adding it here — the extractors type their
 * rule ids against this table.
 */
export interface RejectionRule {
  readonly id: RejectionRuleId;
  readonly channel: 'email' | 'website' | 'social';
  /** What the rule drops, in one line. */
  readonly summary: string;
  /** A value this rule really fired on, from the pages under `fixtures/`. */
  readonly example: string;
}

export const REJECTION_RULES: ReadonlyArray<RejectionRule> = [
  {
    id: 'email_empty_mailto',
    channel: 'email',
    summary: 'A `mailto:` link with no address — the page\'s "send this to a friend" widget.',
    example: 'mailto:?subject=gradjevinarstvo.rs - AUSTROTHERM&body=https://...',
  },
  {
    id: 'email_invalid_syntax',
    channel: 'email',
    summary:
      'Fails the address grammar or the length limits (64-character local part, 254 in total).',
    example: 'ime@@firma.rs',
  },
  {
    id: 'email_invalid_domain',
    channel: 'email',
    summary:
      'The domain is not a real host: a single label, a hyphen at a label edge, or a TLD that is not 2–24 letters.',
    example: 'ime@localhost',
  },
  {
    id: 'email_asset_filename',
    channel: 'email',
    summary:
      'An image or asset filename that looks like an address — retina sprites are the usual source.',
    example: 'logo@2x.png',
  },
  {
    id: 'email_placeholder',
    channel: 'email',
    summary: 'A template placeholder the site never replaced.',
    example: 'ime@example.com',
  },
  {
    id: 'email_noreply_mailbox',
    channel: 'email',
    summary: 'An unattended mailbox: no-reply, mailer-daemon, postmaster, abuse, bounce.',
    example: 'noreply@portal-srbija.com',
  },
  {
    id: 'email_directory_domain',
    channel: 'email',
    summary:
      'The address belongs to the directory the page was scraped from, not to the business — its registrable domain equals the source domain.',
    example: 'info@poslovnikontakt.com scraped from poslovnikontakt.com',
  },
  {
    id: 'email_source_owned',
    channel: 'email',
    summary:
      "The directory's own address on a free provider, which the domain comparison cannot see. Supplied per source by the adapter.",
    example: 'biznisimeniksrbije@gmail.com on every biznisgroup.rs listing',
  },
  {
    id: 'email_tracking_address',
    channel: 'email',
    summary:
      'A machine-generated address: a hex or UUID mailbox, a `+`-tagged tracker, or an email-service-provider domain.',
    example: 'bounce+7f3a91c0d4e2@mg.sendgrid.net',
  },
  {
    id: 'website_unparseable',
    channel: 'website',
    summary:
      'Not an absolute http(s) URL once the usual damage is repaired: `#`, `tel:`, `javascript:`, a relative path, an empty href.',
    example: 'javascript:void(0)',
  },
  {
    id: 'website_source_domain',
    channel: 'website',
    summary: 'Points back at the directory itself or one of its subdomains.',
    example: 'https://mojafirma.navidiku.rs/ on navidiku.rs',
  },
  {
    id: 'website_source_sibling',
    channel: 'website',
    summary:
      "The same brand under another TLD — the directory's foreign editions, printed in every footer.",
    example: 'https://www.daibau.de on daibau.rs',
  },
  {
    id: 'website_known_directory',
    channel: 'website',
    summary:
      "Another listing portal or classifieds site. A business is listed there; it is not the business's own site.",
    example: 'http://www.pttimenik.com linked from a stovarista.rs listing',
  },
  {
    id: 'website_social_network',
    channel: 'website',
    summary: "A social network profile — that is the social extractor's job, never the website.",
    example: 'https://www.facebook.com/Austrotherm.rs/',
  },
  {
    id: 'website_share_intent',
    channel: 'website',
    summary: 'A share or intent widget rather than a destination.',
    example: 'https://x.com/intent/tweet?via=austrotherm&url=...',
  },
  {
    id: 'website_vendor_credit',
    channel: 'website',
    summary:
      'The "web dizajn / izrada sajta / hosting" credit in the footer, which points at the agency that built the directory.',
    example: 'https://greenfish.rs/ with the anchor text "Web dizajn"',
  },
  {
    id: 'website_advertising_banner',
    channel: 'website',
    summary: 'A paid banner, recognised by its campaign parameters.',
    example: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=baner468x60',
  },
  {
    id: 'website_infrastructure',
    channel: 'website',
    summary:
      'Platform, CDN, standards or analytics infrastructure that no business owns as its site.',
    example: 'https://www.w3.org/WAI/tutorials/images/decision-tree/',
  },
  {
    id: 'website_asset_or_document',
    channel: 'website',
    summary: 'A file rather than a site: PDF price lists, images, archives.',
    example: 'https://firma.rs/cenovnik-2026.pdf',
  },
  {
    id: 'website_ambiguous_link_farm',
    channel: 'website',
    summary:
      "Several outbound links survived and not one of them is labelled as the company's site. A sidebar of advertisers is not evidence, so no website is recorded rather than a guessed one.",
    example: 'eight unlabelled advertiser links on a biznisgroup.rs listing',
  },
  {
    id: 'social_share_intent',
    channel: 'social',
    summary:
      'A share button, not a profile: `sharer.php`, `share.php`, `/intent/tweet`, `pin/create/button`, `shareArticle`.',
    example:
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.majstorimajstori.com%2F...',
  },
  {
    id: 'social_platform_root',
    channel: 'social',
    summary: "The network's own home page with no profile in the path.",
    example: 'https://www.facebook.com/',
  },
  {
    id: 'social_not_a_profile',
    channel: 'social',
    summary:
      "A post, a photo, a hashtag, a group, a login or a help page — the path's first segment is reserved.",
    example: 'https://www.instagram.com/p/CxYz12AbCdE/',
  },
  {
    id: 'social_directory_profile',
    channel: 'social',
    summary:
      "The directory's own profile, linked from every listing it publishes. Matched by brand against the source domain.",
    example: 'https://www.facebook.com/Navidiku.rs on navidiku.rs',
  },
  {
    id: 'social_no_stable_identifier',
    channel: 'social',
    summary:
      'A Google Maps URL that carries no place id, cid, ftid or coordinates — a directions link to a typed address.',
    example: 'https://maps.google.com/maps?daddr=Beograd%2C+Beograd%2C+38',
  },
];

const BY_ID = new Map<RejectionRuleId, RejectionRule>(
  REJECTION_RULES.map((rule) => [rule.id, rule]),
);

/** Look a rule up for the validation report. */
export function rejectionRule(id: RejectionRuleId): RejectionRule {
  const rule = BY_ID.get(id);
  if (rule === undefined) throw new Error(`Unknown rejection rule: ${id}`);
  return rule;
}

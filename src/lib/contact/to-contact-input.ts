/**
 * The boundary between extraction and persistence.
 *
 * The extractors answer "what is on this page"; `lead_contacts` stores claims.
 * This is the only place that translates one into the other, so there is no
 * second contact model anywhere in the codebase — `ContactInput` from
 * `src/lib/db/repo.ts` is the shape, `CONTACT_KINDS` are the kinds.
 *
 * Two decisions worth knowing about:
 *
 * - **`domain` is null for a free or ISP mailbox.** The column is the indexed
 *   dedup key. `gmail.com` or `beotel.rs` in it would merge every sole trader
 *   in Serbia into one lead, so a free-provider address stores no domain. A
 *   business-domain address does, which is what makes `info@firma.rs` and
 *   `https://firma.rs` recognisable as the same business.
 * - **`confidence` is about the reading, not the business.** A `mailto:` we
 *   read verbatim is 1; an address reassembled from `ime [at] firma [dot] rs`
 *   is 0.8, because that pattern can also fire on ordinary prose.
 */
import type { ContactInput } from '../db/repo.js';
import type {
  ExtractedEmail,
  ExtractedSocials,
  NormalizedWebsite,
  SocialProfile,
} from './types.js';

/** Everything the three extractors found for one business on one page. */
export interface ExtractedContacts {
  readonly emails?: readonly ExtractedEmail[];
  readonly website?: NormalizedWebsite | null;
  readonly socials?: ExtractedSocials;
}

const OBFUSCATION_CONFIDENCE: Record<ExtractedEmail['obfuscation'], number> = {
  none: 1,
  mailto: 1,
  'html-entity': 1,
  cloudflare: 1,
  'at-word': 0.8,
  spaced: 0.8,
};

/** How sure we are the winning link is the business's own site, by what proved it. */
const WEBSITE_CONFIDENCE: Record<NormalizedWebsite['evidence'], number> = {
  'anchor-text-keyword': 1,
  'anchor-text-is-domain': 0.9,
  'mailto-domain': 0.8,
  'only-external-link': 0.7,
  'ranked-first': 0.6,
};

function socialInput(profile: SocialProfile): ContactInput {
  const kind = profile.network === 'googleMaps' ? 'google_maps' : profile.network;
  return {
    kind,
    value: profile.url,
    valueRaw: profile.raw,
    domain: null,
    handle: profile.id,
    isPrimary: true,
    valid: true,
    confidence: profile.idKind === 'coordinates' || profile.idKind === 'short_link' ? 0.7 : 1,
  };
}

/**
 * Turn extractor output into `lead_contacts` claims, ready for
 * `upsertLead({ contacts })`.
 *
 * The first non-role email is the primary one — a salesperson would rather
 * write to `marko@firma.rs` than to `info@firma.rs` — and the website and each
 * social profile are primary because there is only ever one of each.
 */
export function toContactInputs(extracted: ExtractedContacts): ContactInput[] {
  const contacts: ContactInput[] = [];
  const emails = extracted.emails ?? [];
  const primaryEmail = emails.find((email) => !email.role) ?? emails[0];

  for (const email of emails) {
    contacts.push({
      kind: 'email',
      value: email.email,
      valueRaw: email.raw,
      domain: email.freeProvider ? null : email.registrableDomain,
      handle: null,
      isPrimary: email === primaryEmail,
      valid: true,
      confidence: OBFUSCATION_CONFIDENCE[email.obfuscation],
    });
  }

  const website = extracted.website;
  if (website !== null && website !== undefined) {
    contacts.push({
      kind: 'website',
      value: website.url,
      valueRaw: website.raw,
      domain: website.registrableDomain,
      handle: null,
      isPrimary: true,
      valid: true,
      confidence: WEBSITE_CONFIDENCE[website.evidence],
    });
  }

  const socials = extracted.socials;
  if (socials !== undefined) {
    for (const profile of [socials.facebook, socials.instagram, socials.googleMaps]) {
      if (profile !== undefined) contacts.push(socialInput(profile));
    }
  }

  return contacts;
}

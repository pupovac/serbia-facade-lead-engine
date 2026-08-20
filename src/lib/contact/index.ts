/**
 * Contact-channel extraction: emails, the business's own website, and social
 * profiles, each reduced to the stable form the deduplicator compares.
 */
export {
  decodeCloudflareEmail,
  decodeNumericEntities,
  extractEmails,
  extractEmailsWithRejections,
  FREE_EMAIL_PROVIDERS,
} from './email.js';
export {
  canonicalizeWebsite,
  extractWebsite,
  extractWebsiteWithRejections,
  resolveFinalWebsite,
} from './website.js';
export type { RedirectProbe } from './website.js';
export { extractSocials, extractSocialsWithRejections } from './social.js';
export { toContactInputs } from './to-contact-input.js';
export type { ExtractedContacts } from './to-contact-input.js';
export { REJECTION_RULES, rejectionRule } from './rejection-rules.js';
export type { RejectionRule } from './rejection-rules.js';
export {
  brandLabel,
  canonicalUrlString,
  isSameSite,
  normalizeHost,
  parseLooseUrl,
  registrableDomain,
  TRACKING_PARAMS,
} from './url.js';
export { KNOWN_DIRECTORY_DOMAINS, SHORTENER_DOMAINS, SOCIAL_DOMAINS } from './directories.js';
export type * from './types.js';

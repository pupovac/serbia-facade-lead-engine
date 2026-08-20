/**
 * Email extraction.
 *
 * Serbian listing pages hide addresses in five ways, all of them met in the
 * pages under `fixtures/`: a plain `mailto:`, `ime [at] firma [dot] rs`,
 * HTML entities (`&#107;ontakt&#64;firma.rs`), Cloudflare's
 * `data-cfemail` scrambling, and a plain address with spaces around the `@`.
 * All five are decoded here; every rejection is reported with the rule that
 * fired, because the validation report has to explain a dropped address.
 *
 * What is deliberately KEPT:
 * - `gmail.com`, `yahoo.com`, `beotel.rs`, `sbb.rs` and the other free and ISP
 *   mailboxes. Most fasaderi are sole traders and that is their business
 *   address. They are flagged `freeProvider` so dedup never treats the domain
 *   as an identity, but they are never dropped.
 * - Role addresses (`info@`, `prodaja@`) on the business's own domain. Only
 *   role addresses on the *directory's* domain are dropped.
 */
import { normalizeHost, registrableDomain } from './url.js';
import type {
  EmailObfuscation,
  EmailOptions,
  EmailRejectionRuleId,
  ExtractedEmail,
  Rejection,
} from './types.js';

/** Mailboxes nobody reads. */
const NOREPLY_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'nereply',
  'bounce',
  'bounces',
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'abuse',
  'spam',
  'null',
  'undisclosed-recipients',
]);

/** A department, not a person. Kept — a lead with only `info@` is still a lead. */
const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info',
  'informacije',
  'office',
  'kancelarija',
  'kontakt',
  'contact',
  'prodaja',
  'sales',
  'komercijala',
  'marketing',
  'uprava',
  'direktor',
  'sekretarijat',
  'podrska',
  'support',
  'servis',
  'nabavka',
  'magacin',
  'racunovodstvo',
  'finansije',
  'ponude',
  'upit',
  'webmaster',
  'admin',
  'administracija',
  'mail',
  'email',
]);

/**
 * Free mailbox and Serbian ISP domains. Not a rejection — a flag, so the
 * deduplicator never merges two businesses because both use `@gmail.com`.
 */
export const FREE_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'hotmail.rs',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'gmx.net',
  'gmx.com',
  'mail.ru',
  'yandex.com',
  'yandex.ru',
  'zoho.com',
  // Serbian ISP mailboxes — a business address, never a business identity.
  'beotel.rs',
  'beotel.net',
  'sbb.rs',
  'eunet.rs',
  'open.telekom.rs',
  'telekom.rs',
  'mts.rs',
  'ptt.rs',
  'verat.net',
  'neobee.net',
  'sezampro.rs',
  'orion.rs',
  'nadlanu.com',
]);

const PLACEHOLDER_DOMAINS: ReadonlySet<string> = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.rs',
  'primer.rs',
  'test.com',
  'test.rs',
  'domain.com',
  'domena.rs',
  'yourdomain.com',
  'yourcompany.com',
  'mydomain.com',
  'email.tld',
  'sajt.rs',
  'localhost.com',
]);

/** Email-service-provider infrastructure: transactional senders, never a business inbox. */
const ESP_DOMAIN =
  /(^|\.)(sendgrid\.net|mailgun\.org|mcsv\.net|mcdlv\.net|list-manage\.com|amazonses\.com|mktomail\.com|sparkpostmail\.com|sentry\.io|wixpress\.com|zendesk\.com|intercom-mail\.com|bounces?\.[a-z0-9-]+\.[a-z]{2,})$/i;

/** File extensions that turn `logo@2x.png` into a fake address. */
const ASSET_EXTENSION: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'bmp',
  'css',
  'js',
  'json',
  'pdf',
  'zip',
  'woff',
  'woff2',
  'ttf',
  'mp4',
  'webm',
]);

const HEX_MAILBOX = /^[0-9a-f]{20,}$/i;
const UUID_MAILBOX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACKING_TAG = /\+(?:[0-9a-f]{12,}|track|tracking|campaign|unsub|bounce)/i;

const LOCAL = String.raw`[A-Za-z0-9!#$%&'*+/=?^_\`{|}~.\-]{1,64}`;
const LABEL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const PLAIN_EMAIL = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+\-@])${LOCAL}@${LABEL}(?:\.${LABEL})+`,
  'g',
);

/** `[at]`, `(at)`, `{at}`, ` at `, ` et `, ` @ ` — the at-sign, spelled out. */
const AT_TOKEN = String.raw`(?:\s*[[({]\s*(?:at|et|@|kod|majmun)\s*[\])}]\s*|\s+(?:at|et)\s+|\s+@\s+)`;
/** `[dot]`, `(dot)`, `{tacka}`, ` dot `, ` tacka ` — the dot, spelled out. */
const DOT_TOKEN = String.raw`(?:\s*[[({]\s*(?:dot|tacka|tačka|punkt|\.)\s*[\])}]\s*|\s+(?:dot|tacka|tačka)\s+)`;
const ANY_DOT = `(?:${DOT_TOKEN}|\\.)`;

/** `ime [at] firma.rs` — obfuscated at-sign, dots either way. */
const OBFUSCATED_AT = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+\-@])${LOCAL}${AT_TOKEN}${LABEL}(?:${ANY_DOT}${LABEL})+`,
  'gi',
);
/** `ime@firma(dot)rs` — plain at-sign, at least one obfuscated dot. */
const OBFUSCATED_DOT = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+\-@])${LOCAL}\s*@\s*${LABEL}(?:${ANY_DOT}${LABEL})*${DOT_TOKEN}${LABEL}(?:${ANY_DOT}${LABEL})*`,
  'gi',
);

const MAILTO = /mailto:([^"'<>\s)]*)/gi;
const CF_ATTRIBUTE = /data-cfemail=["']([0-9a-fA-F]{6,})["']/g;
const CF_HREF = /\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]{6,})/g;
const NUMERIC_ENTITY = /&#(x?)([0-9a-fA-F]+);?/g;

/** Decode the numeric HTML entities directories sprinkle through addresses. */
export function decodeNumericEntities(text: string): string {
  return text.replace(NUMERIC_ENTITY, (match, hex: string, digits: string) => {
    const code = Number.parseInt(digits, hex === '' ? 10 : 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

/**
 * Decode Cloudflare's `data-cfemail` scrambling: the first byte is the XOR key
 * for every byte after it. biznisgroup.rs hides its address exactly this way.
 */
export function decodeCloudflareEmail(hex: string): string | null {
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(key)) return null;
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(byte)) return null;
    out += String.fromCharCode(byte ^ key);
  }
  try {
    return decodeURIComponent(out);
  } catch {
    return out;
  }
}

/**
 * Trim a domain that ran into the next word.
 *
 * Meta descriptions concatenate fields without a space —
 * `hemoluks@beotel.rsWeb-site: www.hemoluks.com` on pttimenik.com is real —
 * and a greedy match swallows the next word into the TLD. When the last label
 * is not a plain TLD but starts with one in lower case followed by an
 * upper-case letter, cut it there. Anything else is left alone and fails
 * validation as it should.
 */
function trimRunOnDomain(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 0) return value;
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (/^[A-Za-z]{2,24}$/.test(last)) return value;
  const cut = /^([a-z]{2,24})(?=[A-Z])/.exec(last);
  if (cut === null) return value;
  labels[labels.length - 1] = cut[1] ?? last;
  return `${value.slice(0, at)}@${labels.join('.')}`;
}

interface Candidate {
  readonly raw: string;
  readonly value: string;
  readonly obfuscation: EmailObfuscation;
  /** Where on the page it was found, so the result keeps document order. */
  readonly at: number;
}

/** Turn `ime [at] firma [dot] rs` back into `ime@firma.rs`. */
function deobfuscate(raw: string): string {
  return raw
    .replace(new RegExp(AT_TOKEN, 'gi'), '@')
    .replace(new RegExp(DOT_TOKEN, 'gi'), '.')
    .replace(/\s+/g, '');
}

function pushCandidates(
  into: Candidate[],
  text: string,
  pattern: RegExp,
  obfuscation: EmailObfuscation,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    into.push({ raw, value: deobfuscate(raw), obfuscation, at: match.index });
  }
}

function collectCandidates(text: string, links: readonly string[]): Candidate[] {
  const candidates: Candidate[] = [];

  const LINK_OFFSET = text.length;
  let sourceIndex = -1;
  for (const source of [text, ...links]) {
    sourceIndex += 1;
    MAILTO.lastIndex = 0;
    for (const match of source.matchAll(MAILTO)) {
      const target = (match[1] ?? '').split('?')[0] ?? '';
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // A stray `%` in a hand-written href — use the raw form.
      }
      // An empty `mailto:` is the "send to a friend" widget; keep it as a
      // candidate so the rule that drops it is reported rather than silent.
      candidates.push({
        raw: match[0],
        value: decoded.trim(),
        obfuscation: 'mailto',
        at: sourceIndex === 0 ? match.index : LINK_OFFSET + sourceIndex,
      });
    }
  }

  for (const match of text.matchAll(CF_ATTRIBUTE)) {
    const decoded = decodeCloudflareEmail(match[1] ?? '');
    if (decoded !== null) {
      candidates.push({
        raw: match[0],
        value: decoded,
        obfuscation: 'cloudflare',
        at: match.index,
      });
    }
  }
  for (const match of text.matchAll(CF_HREF)) {
    const decoded = decodeCloudflareEmail(match[1] ?? '');
    if (decoded !== null && decoded.includes('@') && !decoded.startsWith('?')) {
      candidates.push({
        raw: match[0],
        value: decoded,
        obfuscation: 'cloudflare',
        at: match.index,
      });
    }
  }

  const plain: Candidate[] = [];
  pushCandidates(plain, text, PLAIN_EMAIL, 'none');
  for (const link of links) pushCandidates(plain, link, PLAIN_EMAIL, 'none');

  const decodedText = decodeNumericEntities(text);
  if (decodedText !== text) {
    const seen = new Set(plain.map((candidate) => candidate.value.toLowerCase()));
    const entity: Candidate[] = [];
    pushCandidates(entity, decodedText, PLAIN_EMAIL, 'html-entity');
    for (const candidate of entity) {
      if (!seen.has(candidate.value.toLowerCase())) plain.push(candidate);
    }
  }

  const obfuscated: Candidate[] = [];
  pushCandidates(obfuscated, text, OBFUSCATED_AT, 'at-word');
  pushCandidates(obfuscated, text, OBFUSCATED_DOT, 'at-word');
  for (const candidate of obfuscated) {
    // ` @ ` is a spacing trick rather than a spelled-out at-sign; label it honestly.
    const obfuscation: EmailObfuscation = /[[({]/.test(candidate.raw) ? 'at-word' : 'spaced';
    candidates.push({ ...candidate, obfuscation });
  }

  return [...candidates, ...plain].sort((a, b) => a.at - b.at);
}

interface Classified {
  readonly localPart: string;
  readonly domain: string;
}

function split(value: string): Classified | null {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { localPart: value.slice(0, at), domain: value.slice(at + 1).toLowerCase() };
}

function domainRejection(domain: string): EmailRejectionRuleId | null {
  const labels = domain.split('.');
  if (labels.length < 2) return 'email_invalid_domain';
  if (labels.some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) {
    return 'email_invalid_domain';
  }
  const tld = labels[labels.length - 1] ?? '';
  if (ASSET_EXTENSION.has(tld)) return 'email_asset_filename';
  if (!/^[a-z]{2,24}$/i.test(tld)) return 'email_invalid_domain';
  if (PLACEHOLDER_DOMAINS.has(domain)) return 'email_placeholder';
  if (domain.startsWith('example.')) return 'email_placeholder';
  return null;
}

/**
 * Every address on the page, plus every address that was dropped and the rule
 * that dropped it. `extractEmails` is this without the rejections.
 */
export function extractEmailsWithRejections(
  text: string,
  opts: EmailOptions,
): { emails: ExtractedEmail[]; rejected: Rejection[] } {
  const candidates = collectCandidates(text, opts.links ?? []);
  const sourceRegistrable = registrableDomain(opts.sourceDomain);
  const owned = new Set(
    (opts.sourceOwnedEmails ?? []).map((address) => address.trim().toLowerCase()),
  );

  const emails: ExtractedEmail[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const seenRejections = new Set<string>();

  const reject = (value: string, rule: EmailRejectionRuleId, detail?: string): void => {
    const key = `${rule}:${value.toLowerCase()}`;
    if (seenRejections.has(key)) return;
    seenRejections.add(key);
    rejected.push(detail === undefined ? { value, rule } : { value, rule, detail });
  };

  for (const candidate of candidates) {
    const value = trimRunOnDomain(candidate.value.trim().replace(/^<|>$/g, ''));
    if (value === '' || !value.includes('@')) {
      if (candidate.obfuscation === 'mailto') reject(candidate.raw, 'email_empty_mailto');
      continue;
    }
    if (value.length > 254) {
      reject(value, 'email_invalid_syntax', 'longer than 254 characters');
      continue;
    }
    const parts = split(value);
    if (parts === null || value.split('@').length !== 2) {
      reject(value, 'email_invalid_syntax');
      continue;
    }
    const { localPart, domain } = parts;
    if (
      localPart.length > 64 ||
      localPart.startsWith('.') ||
      localPart.endsWith('.') ||
      localPart.includes('..') ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(localPart)
    ) {
      reject(value, 'email_invalid_syntax');
      continue;
    }

    const domainRule = domainRejection(domain);
    if (domainRule !== null) {
      reject(value, domainRule);
      continue;
    }

    const canonical = `${localPart.toLowerCase()}@${normalizeHost(domain)}`;
    const registrable = registrableDomain(domain);
    const localLower = localPart.toLowerCase();

    if (NOREPLY_LOCAL_PARTS.has(localLower) || localLower.startsWith('no-reply')) {
      reject(canonical, 'email_noreply_mailbox');
      continue;
    }
    if (
      ESP_DOMAIN.test(domain) ||
      HEX_MAILBOX.test(localLower) ||
      UUID_MAILBOX.test(localLower) ||
      TRACKING_TAG.test(localLower)
    ) {
      reject(canonical, 'email_tracking_address');
      continue;
    }
    if (sourceRegistrable !== '' && registrable === sourceRegistrable) {
      reject(canonical, 'email_directory_domain', `owned by ${opts.sourceDomain}`);
      continue;
    }
    if (owned.has(canonical)) {
      reject(canonical, 'email_source_owned', `listed as owned by ${opts.sourceDomain}`);
      continue;
    }

    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const raw = value === candidate.value ? candidate.raw : candidate.raw.slice(0, value.length);
    emails.push({
      email: canonical,
      raw,
      localPart: localPart.toLowerCase(),
      domain: normalizeHost(domain),
      registrableDomain: registrable,
      obfuscation: candidate.obfuscation,
      role: ROLE_LOCAL_PARTS.has(localLower),
      freeProvider: FREE_EMAIL_PROVIDERS.has(normalizeHost(domain)),
    });
  }

  return { emails, rejected };
}

/**
 * Every usable address in `text`, obfuscation decoded, directory-owned noise
 * removed. Pass the page's raw HTML — `mailto:` hrefs, `data-cfemail`
 * attributes and entity-encoded text are all read out of it — or plain text
 * plus the anchor hrefs in `opts.links`.
 */
export function extractEmails(text: string, opts: EmailOptions): ExtractedEmail[] {
  return extractEmailsWithRejections(text, opts).emails;
}

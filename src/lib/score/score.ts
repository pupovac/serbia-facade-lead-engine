/**
 * The lead score: 0–100 of data completeness and relevance.
 *
 * Pure, and it returns its own arithmetic. The review UI sorts on the number
 * and explains it with `components`, so "why is this lead below that one" is a
 * question the interface answers rather than a question a human asks us.
 */
import {
  ADDITIONAL_PHONE_CAP,
  CLASSIFICATION_RELEVANCE,
  CORROBORATION_CAP,
  MAX_SCORE,
  NO_PHONE_CEILING,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  SCORE_WEIGHTS,
} from './weights.js';
import type { LeadScore, ScoreComponent, ScoreInput } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function distinct(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))];
}

/** Score one lead. No clock, no I/O — pass `now` in when recency matters. */
export function scoreLead(input: ScoreInput): LeadScore {
  const components: ScoreComponent[] = [];
  const add = (id: ScoreComponent['id'], points: number, max: number, detail: string): void => {
    components.push({ id, points: Math.round(points * 100) / 100, max, detail });
  };

  // Phones. Only valid, distinct numbers earn anything; an unparseable string
  // is kept on the lead for auditing and is worth nothing to a caller.
  const phones = (input.phones ?? []).filter((p) => p.valid !== false && p.e164.trim() !== '');
  const uniquePhones = [...new Map(phones.map((p) => [p.e164, p])).values()];
  const hasPhone = uniquePhones.length > 0;
  add(
    'phone',
    hasPhone ? SCORE_WEIGHTS.phone : 0,
    SCORE_WEIGHTS.phone,
    hasPhone ? `${uniquePhones.length} phone${uniquePhones.length === 1 ? '' : 's'}` : 'no phone',
  );

  const extra = Math.min(Math.max(uniquePhones.length - 1, 0), ADDITIONAL_PHONE_CAP);
  add(
    'additionalPhone',
    (SCORE_WEIGHTS.additionalPhone * extra) / ADDITIONAL_PHONE_CAP,
    SCORE_WEIGHTS.additionalPhone,
    extra === 0 ? 'no second number' : `${extra} additional number${extra === 1 ? '' : 's'}`,
  );

  const mobiles = uniquePhones.filter((p) => p.type === 'mobile').length;
  add(
    'mobileLine',
    mobiles > 0 ? SCORE_WEIGHTS.mobileLine : 0,
    SCORE_WEIGHTS.mobileLine,
    mobiles > 0 ? `${mobiles} mobile` : 'landline only',
  );

  const emails = distinct(input.emails);
  add(
    'email',
    emails.length > 0 ? SCORE_WEIGHTS.email : 0,
    SCORE_WEIGHTS.email,
    emails.length > 0 ? `${emails.length} email` : 'no email',
  );

  const websites = distinct(input.websites);
  add(
    'website',
    websites.length > 0 ? SCORE_WEIGHTS.website : 0,
    SCORE_WEIGHTS.website,
    websites.length > 0 ? (websites[0] ?? 'website') : 'no website',
  );

  const socials = distinct(input.socials);
  add(
    'social',
    socials.length > 0 ? SCORE_WEIGHTS.social : 0,
    SCORE_WEIGHTS.social,
    socials.length > 0 ? `${socials.length} profile` : 'no social profile',
  );

  // City, scaled by how the match was made. `resolveCity` already scores an
  // area-code fallback at 0.35 and an exact name at 1, so a lead whose city was
  // guessed from a landline prefix scores about a third of a lead whose
  // listing said "Novi Sad".
  const cityConfidence = input.city == null ? 0 : Math.max(0, Math.min(1, input.city.confidence));
  add(
    'city',
    SCORE_WEIGHTS.city * cityConfidence,
    SCORE_WEIGHTS.city,
    input.city == null
      ? 'no city resolved'
      : `${input.city.matchedVia} match, confidence ${input.city.confidence}`,
  );

  const label = input.classification?.label ?? 'UNKNOWN';
  const relevance = CLASSIFICATION_RELEVANCE[label] ?? 0;
  const classificationConfidence = Math.max(
    0,
    Math.min(1, input.classification?.confidence ?? (relevance > 0 ? 1 : 0)),
  );
  add(
    'classification',
    SCORE_WEIGHTS.classification * relevance * classificationConfidence,
    SCORE_WEIGHTS.classification,
    relevance === 0 ? 'UNKNOWN' : `${label} at ${classificationConfidence}`,
  );

  const sources = distinct(input.sourceIds);
  const corroboration = Math.min(sources.length, CORROBORATION_CAP);
  add(
    'corroboration',
    sources.length <= 1
      ? 0
      : (SCORE_WEIGHTS.corroboration * (corroboration - 1)) / (CORROBORATION_CAP - 1),
    SCORE_WEIGHTS.corroboration,
    `${sources.length} source${sources.length === 1 ? '' : 's'}`,
  );

  // Recency. Defaults to full marks when the caller gives no clock — a caller
  // that does not track time should not be silently penalised for it.
  const lastSeen = input.lastSeenAt ?? null;
  const now = input.now ?? lastSeen ?? null;
  let recencyFraction = lastSeen === null || now === null ? 1 : 0;
  let recencyDetail = lastSeen === null ? 'never seen' : 'last seen just now';
  if (lastSeen !== null && now !== null) {
    const days = Math.max(0, (now.getTime() - lastSeen.getTime()) / DAY_MS);
    recencyFraction =
      days <= RECENCY_FULL_DAYS
        ? 1
        : Math.max(0, 1 - (days - RECENCY_FULL_DAYS) / (RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS));
    recencyDetail = `last seen ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`;
  }
  add('recency', SCORE_WEIGHTS.recency * recencyFraction, SCORE_WEIGHTS.recency, recencyDetail);

  let total = components.reduce((sum, c) => sum + c.points, 0);
  let capped = false;
  if (!hasPhone && total > NO_PHONE_CEILING) {
    // Recorded as a component so the UI can say *why* the lead ranks low,
    // rather than silently showing a number that does not add up.
    add(
      'noPhoneCeiling',
      NO_PHONE_CEILING - total,
      0,
      `capped at ${NO_PHONE_CEILING} — no phone number`,
    );
    total = NO_PHONE_CEILING;
    capped = true;
  }

  return {
    score: Math.max(0, Math.min(MAX_SCORE, Math.round(total))),
    components,
    capped,
  };
}

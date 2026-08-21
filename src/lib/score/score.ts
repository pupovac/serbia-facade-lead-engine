/**
 * The two lead scores: relevance, and contactability.
 *
 * Pure, and each returns its own arithmetic. The review UI sorts on either
 * number and explains it with its components, so "why is this lead below that
 * one" is a question the interface answers rather than one a human asks us.
 *
 * The split is the point. Relevance never reads a phone number, an email or a
 * website; contactability never reads a label. A parking garage with two
 * phones and a website is 0 relevant and highly contactable, and the list can
 * finally say so — see `weights.ts` for the pilot numbers that forced it.
 */
import {
  ADDITIONAL_PHONE_CAP,
  CLASSIFICATION_RELEVANCE,
  CONFIDENCE_CEILING,
  CONFIDENCE_FLOOR,
  CONTACTABILITY_WEIGHTS,
  CORROBORATION_CAP,
  EVIDENCE_FULL_NET,
  MAX_SCORE,
  NO_PHONE_CEILING,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  RELEVANCE_WEIGHTS,
} from './weights.js';
import type {
  LeadScore,
  RelevanceComponent,
  ScoreClassification,
  ScoreComponent,
  ScoreInput,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function distinct(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * The one derived sort key: `relevance × contactability / 100`.
 *
 * Relevance gates, contactability ranks. A lead that is not a lead scores 0
 * however reachable it is — which is the whole point. The owner browses this
 * column, and before FUZZ-37 a parking garage sat at 76 in it.
 *
 * Exported because the re-grade scripts and any backfill must derive it the
 * same way the scorer does; two copies of this multiplication is one copy too
 * many.
 */
export function deriveLeadScore(relevance: number, contactability: number): number {
  return Math.round((relevance * contactability) / MAX_SCORE);
}

/**
 * Relevance: is this a lead for us?
 *
 * Reads `input.classification` and nothing else — the signature is the
 * guarantee. Both undecided labels score 0 outright: an `OUT_OF_SCOPE` blinds
 * workshop and an `UNCLASSIFIED` row with no evidence are equally not leads,
 * however complete their contact cards are.
 */
export function scoreRelevance(classification: ScoreClassification | undefined): {
  score: number;
  components: RelevanceComponent[];
} {
  const components: RelevanceComponent[] = [];
  const add = (id: RelevanceComponent['id'], points: number, max: number, detail: string): void => {
    components.push({ id, points: Math.round(points * 100) / 100, max, detail });
  };

  const label = classification?.label ?? 'UNCLASSIFIED';
  const inScope = CLASSIFICATION_RELEVANCE[label] ?? 0;
  add(
    'label',
    RELEVANCE_WEIGHTS.label * inScope,
    RELEVANCE_WEIGHTS.label,
    inScope === 0 ? `${label} — not a buyer group` : label,
  );

  // A confidence on an undecided label measures how sure we are it is *not* a
  // lead. Paying for that would rank the most confidently irrelevant rows
  // highest, so both remaining components are gated on the label.
  const rawConfidence = clamp01(classification?.confidence ?? (inScope > 0 ? 1 : 0));
  const confidenceFraction =
    inScope === 0
      ? 0
      : clamp01((rawConfidence - CONFIDENCE_FLOOR) / (CONFIDENCE_CEILING - CONFIDENCE_FLOOR));
  add(
    'confidence',
    RELEVANCE_WEIGHTS.confidence * confidenceFraction,
    RELEVANCE_WEIGHTS.confidence,
    inScope === 0 ? 'no label to be confident about' : `classifier confidence ${rawConfidence}`,
  );

  const net = classification?.evidenceNet;
  const hasNet = net != null && Number.isFinite(net);
  const evidenceFraction =
    inScope === 0 ? 0 : hasNet ? clamp01(net / EVIDENCE_FULL_NET) : confidenceFraction;
  add(
    'evidence',
    RELEVANCE_WEIGHTS.evidence * evidenceFraction,
    RELEVANCE_WEIGHTS.evidence,
    inScope === 0
      ? 'no evidence for a buyer group'
      : hasNet
        ? `net evidence ${Math.round(net * 100) / 100}`
        : 'evidence not stored — confidence stands in',
  );

  const total = components.reduce((sum, c) => sum + c.points, 0);
  return { score: Math.max(0, Math.min(MAX_SCORE, Math.round(total))), components };
}

/**
 * Score one lead on both axes. No clock, no I/O — pass `now` in when recency
 * matters.
 */
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
    hasPhone ? CONTACTABILITY_WEIGHTS.phone : 0,
    CONTACTABILITY_WEIGHTS.phone,
    hasPhone ? `${uniquePhones.length} phone${uniquePhones.length === 1 ? '' : 's'}` : 'no phone',
  );

  const extra = Math.min(Math.max(uniquePhones.length - 1, 0), ADDITIONAL_PHONE_CAP);
  add(
    'additionalPhone',
    (CONTACTABILITY_WEIGHTS.additionalPhone * extra) / ADDITIONAL_PHONE_CAP,
    CONTACTABILITY_WEIGHTS.additionalPhone,
    extra === 0 ? 'no second number' : `${extra} additional number${extra === 1 ? '' : 's'}`,
  );

  const mobiles = uniquePhones.filter((p) => p.type === 'mobile').length;
  add(
    'mobileLine',
    mobiles > 0 ? CONTACTABILITY_WEIGHTS.mobileLine : 0,
    CONTACTABILITY_WEIGHTS.mobileLine,
    mobiles > 0 ? `${mobiles} mobile` : 'landline only',
  );

  const emails = distinct(input.emails);
  add(
    'email',
    emails.length > 0 ? CONTACTABILITY_WEIGHTS.email : 0,
    CONTACTABILITY_WEIGHTS.email,
    emails.length > 0 ? `${emails.length} email` : 'no email',
  );

  const websites = distinct(input.websites);
  add(
    'website',
    websites.length > 0 ? CONTACTABILITY_WEIGHTS.website : 0,
    CONTACTABILITY_WEIGHTS.website,
    websites.length > 0 ? (websites[0] ?? 'website') : 'no website',
  );

  const socials = distinct(input.socials);
  add(
    'social',
    socials.length > 0 ? CONTACTABILITY_WEIGHTS.social : 0,
    CONTACTABILITY_WEIGHTS.social,
    socials.length > 0 ? `${socials.length} profile` : 'no social profile',
  );

  // City, scaled by how the match was made. `resolveCity` already scores an
  // area-code fallback at 0.35 and an exact name at 1, so a lead whose city was
  // guessed from a landline prefix scores about a third of a lead whose
  // listing said "Novi Sad".
  const cityConfidence = input.city == null ? 0 : Math.max(0, Math.min(1, input.city.confidence));
  add(
    'city',
    CONTACTABILITY_WEIGHTS.city * cityConfidence,
    CONTACTABILITY_WEIGHTS.city,
    input.city == null
      ? 'no city resolved'
      : `${input.city.matchedVia} match, confidence ${input.city.confidence}`,
  );

  const sources = distinct(input.sourceIds);
  const corroboration = Math.min(sources.length, CORROBORATION_CAP);
  add(
    'corroboration',
    sources.length <= 1
      ? 0
      : (CONTACTABILITY_WEIGHTS.corroboration * (corroboration - 1)) / (CORROBORATION_CAP - 1),
    CONTACTABILITY_WEIGHTS.corroboration,
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
  add(
    'recency',
    CONTACTABILITY_WEIGHTS.recency * recencyFraction,
    CONTACTABILITY_WEIGHTS.recency,
    recencyDetail,
  );

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

  const contactability = Math.max(0, Math.min(MAX_SCORE, Math.round(total)));
  const relevance = scoreRelevance(input.classification);

  return {
    relevance: relevance.score,
    relevanceComponents: relevance.components,
    contactability,
    components,
    score: deriveLeadScore(relevance.score, contactability),
    capped,
  };
}

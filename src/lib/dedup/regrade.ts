/**
 * Re-classify and re-score a lead from whatever is stored on it now.
 *
 * A merged lead is a different record from either of its inputs: it has more
 * text, more phones, more sources and often a city one side did not have. Its
 * label and its score were computed from less than that, so carrying them
 * forward would leave the survivor graded on half its own evidence — an
 * `UNKNOWN` that the merged-in description would have resolved, or a score that
 * never counted the second phone.
 *
 * `repo.applyGrading` overwrites rather than fills a gap, deliberately: grading
 * is derived data and a re-run over better text is meant to replace the
 * previous verdict. A reviewer's own decision lives in `leads.status` and
 * `review_note`, which nothing here touches.
 */
import type { Db } from '../db/client.js';
import { classifyLead } from '../classify/index.js';
import { leadClassificationInput } from '../classify/reclassify.js';
import { scoreLead, toScoreInput } from '../score/index.js';
import {
  applyGrading,
  distinctPhones,
  getLead,
  leadContactClaims,
  leadSourceRows,
} from '../db/repo.js';
import type { LeadClassification } from '../db/schema.js';

export interface RegradeResult {
  readonly leadId: number;
  readonly classification: LeadClassification;
  readonly classificationConfidence: number;
  readonly leadScore: number;
}

/** Re-grade one lead in place. Returns what it now carries. */
export function regradeLead(db: Db, leadId: number, at = new Date()): RegradeResult | undefined {
  const lead = getLead(db, leadId);
  if (!lead) return undefined;

  const contacts = leadContactClaims(db, leadId);

  // Everything every source said, not just the survivor's own row: the source
  // categories live in `raw_records` and a merged lead has more than one of
  // them. Sharing this with `scripts/reclassify.ts` is deliberate — a merge and
  // a re-classification run must not read the same lead differently.
  const classification = classifyLead(
    leadClassificationInput(db, leadId) ?? {
      name: lead.name,
      ...(lead.description == null ? {} : { description: lead.description }),
    },
  );

  const score = scoreLead(
    toScoreInput({
      lead: { ...lead, classification: classification.label },
      phones: distinctPhones(db, leadId),
      contacts,
      sources: leadSourceRows(db, leadId),
      now: at,
    }),
  );

  applyGrading(
    db,
    leadId,
    {
      classification: classification.label,
      classificationConfidence: classification.confidence,
      classificationEvidence: JSON.stringify(classification),
      leadScore: score.score,
      scoreBreakdown: JSON.stringify(score.components),
    },
    at,
  );

  return {
    leadId,
    classification: classification.label,
    classificationConfidence: classification.confidence,
    leadScore: score.score,
  };
}

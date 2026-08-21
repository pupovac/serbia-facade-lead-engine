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
import { classifyLead, decidingNet } from '../classify/index.js';
import { scoreLead, toGrading, toScoreInput } from '../score/index.js';
import {
  applyGrading,
  distinctPhones,
  getLead,
  leadCategories,
  leadContactClaims,
  leadSourceRows,
} from '../db/repo.js';
import type { AdjacentIndustry, LeadClassification } from '../db/schema.js';

export interface RegradeResult {
  readonly leadId: number;
  readonly classification: LeadClassification;
  readonly classificationConfidence: number;
  /** Set only with an `OUT_OF_SCOPE` label: the adjacent trade that decided it. */
  readonly classificationIndustry: AdjacentIndustry | null;
  readonly relevanceScore: number;
  readonly contactabilityScore: number;
  readonly leadScore: number;
}

/** Re-grade one lead in place. Returns what it now carries. */
export function regradeLead(db: Db, leadId: number, at = new Date()): RegradeResult | undefined {
  const lead = getLead(db, leadId);
  if (!lead) return undefined;

  const contacts = leadContactClaims(db, leadId);
  const website = contacts.find((contact) => contact.kind === 'website');

  // The same four fields the scraper pipeline classifies on, categories
  // included — a re-grade that saw less than the first pass would quietly
  // downgrade a label every time two leads merged.
  const categories = leadCategories(db, leadId);
  const classification = classifyLead({
    name: lead.name,
    ...(lead.description == null ? {} : { description: lead.description }),
    ...(categories.length === 0 ? {} : { categories }),
    ...(website == null ? {} : { website: website.value }),
  });

  const score = scoreLead({
    ...toScoreInput({
      lead: { ...lead, classification: classification.label },
      phones: distinctPhones(db, leadId),
      contacts,
      sources: leadSourceRows(db, leadId),
      now: at,
    }),
    // The freshly computed arithmetic, not the blob still on the row — that
    // one belongs to the label this run is about to replace.
    classification: {
      label: classification.label,
      confidence: classification.confidence,
      evidenceNet: decidingNet(classification),
    },
  });

  applyGrading(
    db,
    leadId,
    toGrading(
      {
        label: classification.label,
        confidence: classification.confidence,
        evidence: JSON.stringify(classification),
        industry: classification.industry ?? null,
      },
      score,
    ),
    at,
  );

  return {
    leadId,
    classification: classification.label,
    classificationConfidence: classification.confidence,
    classificationIndustry: classification.industry ?? null,
    relevanceScore: score.relevance,
    contactabilityScore: score.contactability,
    leadScore: score.score,
  };
}

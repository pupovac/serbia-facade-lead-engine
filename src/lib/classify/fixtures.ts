/**
 * The labelled fixture set, and the measurement that turns it into a number.
 *
 * `__fixtures__/labelled-businesses.json` holds 161 real Serbian businesses
 * pulled verbatim from public directory listings and labelled by hand. The set
 * is adversarial on purpose: two thirds of it is companies that publish the
 * words `fasada`, `termoizolacija` or `izolacija` while belonging to a trade we
 * do not sell to — roofers, window fitters, waterproofers, HVAC and pipe
 * insulators, facade *washing* companies, and EPS manufacturers.
 *
 * A classifier that scores well here is one that says `UNKNOWN` a lot.
 */
import fixture from './__fixtures__/labelled-businesses.json' with { type: 'json' };
import { classifyLead } from './classify.js';
import type { ClassificationInput, LeadClassification } from './types.js';

export interface LabelledBusiness {
  readonly name: string;
  readonly city: string;
  readonly expected: LeadClassification;
  /** Why this label, for the records where the call is not obvious. */
  readonly note?: string;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly input: ClassificationInput;
}

interface FixtureRow {
  readonly name: string;
  readonly city: string;
  readonly description: string;
  readonly sourceCategory: string;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly expected: string;
  readonly website?: string;
  readonly note?: string;
}

export const FIXTURE_META = fixture._meta as {
  readonly description: string;
  readonly collected_at: string;
  readonly counts: Readonly<Record<string, number>>;
};

export const LABELLED_BUSINESSES: readonly LabelledBusiness[] = (
  fixture.businesses as readonly FixtureRow[]
).map((row) => ({
  name: row.name,
  city: row.city,
  expected: row.expected as LeadClassification,
  sourceId: row.sourceId,
  sourceUrl: row.sourceUrl,
  ...(row.note === undefined ? {} : { note: row.note }),
  input: {
    name: row.name,
    categories: [row.sourceCategory],
    ...(row.description === '' ? {} : { description: row.description }),
    ...(row.website === undefined ? {} : { website: row.website }),
  },
}));

export interface LabelMetrics {
  /** How many records carry this label in the fixture set. */
  readonly actual: number;
  /** How many records the classifier gave this label. */
  readonly predicted: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** Records that are *not* this label — the denominator of the false-positive rate. */
  readonly negatives: number;
  /** `truePositives / predicted`. 1 when the label was never predicted. */
  readonly precision: number;
  /** `truePositives / actual`. */
  readonly recall: number;
  /** `falsePositives / negatives` — the share of the wrong-industry records that leaked in. */
  readonly falsePositiveRate: number;
}

export interface ClassifierReport {
  readonly total: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly matrix: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly perLabel: Readonly<Record<string, LabelMetrics>>;
}

const ALL_LABELS: readonly LeadClassification[] = [
  'FACADE_CONTRACTOR',
  'CONSTRUCTION_MATERIAL_STORE',
  'BOTH',
  'UNKNOWN',
];

/** Run the classifier over every labelled record and count what happened. */
export function evaluateClassifier(
  businesses: readonly LabelledBusiness[] = LABELLED_BUSINESSES,
): ClassifierReport {
  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of ALL_LABELS) {
    matrix[expected] = Object.fromEntries(ALL_LABELS.map((l) => [l, 0]));
  }

  let correct = 0;
  for (const business of businesses) {
    const predicted = classifyLead(business.input).label;
    const row = matrix[business.expected];
    if (row !== undefined) row[predicted] = (row[predicted] ?? 0) + 1;
    if (predicted === business.expected) correct += 1;
  }

  const perLabel: Record<string, LabelMetrics> = {};
  for (const label of ALL_LABELS) {
    const truePositives = matrix[label]?.[label] ?? 0;
    const actual = ALL_LABELS.reduce((sum, p) => sum + (matrix[label]?.[p] ?? 0), 0);
    const predicted = ALL_LABELS.reduce((sum, e) => sum + (matrix[e]?.[label] ?? 0), 0);
    const falsePositives = predicted - truePositives;
    const negatives = businesses.length - actual;
    perLabel[label] = {
      actual,
      predicted,
      truePositives,
      falsePositives,
      falseNegatives: actual - truePositives,
      negatives,
      precision: predicted === 0 ? 1 : truePositives / predicted,
      recall: actual === 0 ? 1 : truePositives / actual,
      falsePositiveRate: negatives === 0 ? 0 : falsePositives / negatives,
    };
  }

  return {
    total: businesses.length,
    correct,
    accuracy: businesses.length === 0 ? 1 : correct / businesses.length,
    matrix,
    perLabel,
  };
}

/**
 * The measured test: run the classifier over 161 hand-labelled real Serbian
 * businesses and assert the numbers, not the vibe.
 *
 * The thresholds below are floors, deliberately set a little under what the
 * classifier does today, so tuning the signal table is free until it costs
 * accuracy. If a change trips one of these, the change made the classifier
 * worse — read `npx tsx scripts/report-classification-precision.ts --errors`
 * before relaxing anything.
 */
import { describe, expect, it } from 'vitest';
import { toCyrillic } from '../text/cyrillic.js';
import { classifyLead } from './classify.js';
import { LABELLED_BUSINESSES, evaluateClassifier } from './fixtures.js';
import type { ClassificationInput } from './types.js';

const report = evaluateClassifier();

describe('classification precision on the labelled fixture set', () => {
  it('has at least 50 real labelled businesses, as the issue requires', () => {
    expect(LABELLED_BUSINESSES.length).toBeGreaterThanOrEqual(50);
    expect(
      new Set(LABELLED_BUSINESSES.map((b) => b.name.toLowerCase())).size,
    ).toBeGreaterThanOrEqual(50);
  });

  it('covers every label and the adjacent-industry traps', () => {
    const counts = report.perLabel;
    expect(counts['FACADE_CONTRACTOR']?.actual).toBeGreaterThanOrEqual(10);
    expect(counts['CONSTRUCTION_MATERIAL_STORE']?.actual).toBeGreaterThanOrEqual(30);
    expect(counts['BOTH']?.actual).toBeGreaterThanOrEqual(1);
    // The set is mostly negatives on purpose: roofing, joinery, waterproofing,
    // HVAC insulation, facade cleaning and EPS manufacturers.
    expect(counts['UNKNOWN']?.actual).toBeGreaterThanOrEqual(100);
  });

  it('classifies at least 90% of them correctly', () => {
    expect(report.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps FACADE_CONTRACTOR precision at or above 85%', () => {
    const m = report.perLabel['FACADE_CONTRACTOR'];
    expect(m).toBeDefined();
    expect(m?.precision).toBeGreaterThanOrEqual(0.85);
    // Of everything that is not a facade contractor, at most 2% may leak in.
    expect(m?.falsePositiveRate).toBeLessThanOrEqual(0.02);
  });

  it('keeps CONSTRUCTION_MATERIAL_STORE precision at or above 85%', () => {
    const m = report.perLabel['CONSTRUCTION_MATERIAL_STORE'];
    expect(m).toBeDefined();
    expect(m?.precision).toBeGreaterThanOrEqual(0.85);
    expect(m?.falsePositiveRate).toBeLessThanOrEqual(0.05);
  });

  it('never labels an adjacent trade FACADE_CONTRACTOR', () => {
    const leaks = LABELLED_BUSINESSES.filter(
      (b) => b.expected === 'UNKNOWN' && classifyLead(b.input).label === 'FACADE_CONTRACTOR',
    );
    expect(leaks.map((b) => b.name)).toStrictEqual([]);
  });

  it('prefers UNKNOWN over a confident wrong label', () => {
    // Every mistake that is not a miss must be a *near* miss: a store called a
    // contractor or the reverse, never a cleaning company called either.
    const wrongIndustry = LABELLED_BUSINESSES.filter((b) => {
      const got = classifyLead(b.input).label;
      return b.expected === 'UNKNOWN' && got !== 'UNKNOWN';
    });
    expect(wrongIndustry.length).toBeLessThanOrEqual(4);
    for (const business of wrongIndustry) {
      expect(classifyLead(business.input).label).toBe('CONSTRUCTION_MATERIAL_STORE');
    }
  });

  it('recalls most of the businesses that really are in our market', () => {
    for (const label of ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'] as const) {
      expect(report.perLabel[label]?.recall).toBeGreaterThanOrEqual(0.8);
    }
  });

  // A source picks a script and a case and never asks us. Measured on this set
  // before the fix: 48 of the 50 records the classifier labels at all lost
  // their label when the same text was written in Cyrillic. ALL-CAPS Latin
  // already survived — the folding order was right — and this pins both.
  describe('the same business written a different way', () => {
    const rewrite = (
      input: ClassificationInput,
      f: (s: string) => string,
    ): ClassificationInput => ({
      ...input,
      ...(input.name === undefined ? {} : { name: f(input.name) }),
      ...(input.categories === undefined ? {} : { categories: input.categories.map(f) }),
      ...(input.description === undefined ? {} : { description: f(input.description) }),
    });

    it.each([
      ['ALL-CAPS', (s: string) => s.toUpperCase()],
      ['Cyrillic', toCyrillic],
      ['Cyrillic ALL-CAPS', (s: string) => toCyrillic(s).toUpperCase()],
    ])('classifies every fixture identically in %s', (_name, rewriteText) => {
      const changed = LABELLED_BUSINESSES.filter(
        (business) =>
          classifyLead(rewrite(business.input, rewriteText as (s: string) => string)).label !==
          classifyLead(business.input).label,
      );
      expect(changed.map((business) => business.name)).toStrictEqual([]);
    });
  });

  it('gives every classified record auditable evidence', () => {
    for (const business of LABELLED_BUSINESSES) {
      const result = classifyLead(business.input);
      if (result.label === 'UNKNOWN') continue;
      expect(result.evidence.length, business.name).toBeGreaterThan(0);
      expect(result.reason.length, business.name).toBeGreaterThan(0);
      expect(result.confidence, business.name).toBeGreaterThanOrEqual(0.5);
    }
  });
});

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
import { LABELLED_BUSINESSES, evaluateClassifier, toFixtureLabel } from './fixtures.js';
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
    // `UNKNOWN` here is the fixture's vocabulary for "neither buyer group";
    // the classifier answers `UNCLASSIFIED` or `OUT_OF_SCOPE` and
    // `toFixtureLabel` folds both back. The split itself is asserted below.
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

  it('prefers no label at all over a confident wrong one', () => {
    // Every mistake that is not a miss must be a *near* miss: a store called a
    // contractor or the reverse, never a cleaning company called either.
    const wrongIndustry = LABELLED_BUSINESSES.filter((b) => {
      const got = toFixtureLabel(classifyLead(b.input).label);
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

  describe('UNKNOWN split into UNCLASSIFIED and OUT_OF_SCOPE', () => {
    const negatives = LABELLED_BUSINESSES.filter((b) => b.expected === 'UNKNOWN');
    const decided = negatives.map((b) => ({ business: b, result: classifyLead(b.input) }));

    it('rules out a real share of the adversarial set instead of shrugging at it', () => {
      // The fixture is two thirds wrong-industry companies by construction, so
      // a split that never fires would mean the classifier sees the roofing
      // and joinery evidence and does nothing with it.
      // 13 today, all facade-*cleaning* companies. The floor sits under that
      // rather than at it: most of this set publishes `fasada` or
      // `termoizolacija` somewhere, which is in-scope evidence and keeps a
      // record `UNCLASSIFIED` on purpose. On the pilot corpus the same rule
      // ruled out 244 of 3,046 — the share here is the same order.
      const outOfScope = decided.filter((d) => d.result.label === 'OUT_OF_SCOPE');
      expect(outOfScope.length).toBeGreaterThanOrEqual(10);
    });

    it('names the deciding trade on every record it rules out', () => {
      for (const { business, result } of decided) {
        if (result.label !== 'OUT_OF_SCOPE') continue;
        expect(result.industry, business.name).toBeDefined();
        expect(result.reason, business.name).toContain('Out of scope');
      }
    });

    it('never rules out a business that argued for a buyer group at all', () => {
      // `OUT_OF_SCOPE` is excluded from the list and the export, so it is only
      // ever allowed on a record with *zero* facade or materials evidence.
      const wrongly = decided.filter(
        (d) =>
          d.result.label === 'OUT_OF_SCOPE' && d.result.evidence.some((e) => e.axis !== 'adjacent'),
      );
      expect(wrongly.map((d) => d.business.name)).toStrictEqual([]);
    });

    it('never rules out a business the fixture says is a buyer', () => {
      const wrongly = LABELLED_BUSINESSES.filter(
        (b) => b.expected !== 'UNKNOWN' && classifyLead(b.input).label === 'OUT_OF_SCOPE',
      );
      expect(wrongly.map((b) => b.name)).toStrictEqual([]);
    });
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
      if (toFixtureLabel(result.label) === 'UNKNOWN') continue;
      expect(result.evidence.length, business.name).toBeGreaterThan(0);
      expect(result.reason.length, business.name).toBeGreaterThan(0);
      expect(result.confidence, business.name).toBeGreaterThanOrEqual(0.5);
    }
  });
});

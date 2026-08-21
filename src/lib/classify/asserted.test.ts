/**
 * Source-asserted classification.
 *
 * The case these tests exist for is the one the pilot got wrong: a sole trader
 * whose name is a person's name, listed in a directory section that holds
 * nothing but facade contractors. The word-scorer has nothing to read and says
 * `UNKNOWN`; the source already knows the answer.
 */
import { describe, expect, it } from 'vitest';
import { assertClassification } from './asserted.js';
import { classifyLead } from './classify.js';

describe('assertClassification', () => {
  it('takes the label from the source and reports why', () => {
    const result = assertClassification({
      label: 'FACADE_CONTRACTOR',
      reason: 'listed under gradjevinski-radovi/fasader',
    });

    expect(result.label).toBe('FACADE_CONTRACTOR');
    expect(result.confidence).toBe(1);
    expect(result.sourceAsserted).toBe(true);
    expect(result.reason).toContain('gradjevinski-radovi/fasader');
  });

  it('scores no evidence, because it read none', () => {
    const result = assertClassification({ label: 'FACADE_CONTRACTOR', reason: 'a category' });
    expect(result.evidence).toEqual([]);
    expect(result.contractor.net).toBe(0);
    expect(result.contractor.gateOpen).toBe(false);
  });

  /**
   * The audit trail. A source-asserted corpus that the classifier reads as
   * `UNKNOWN` is the measurement that says the signal list is missing terms —
   * and it is only available if the inferred result is kept.
   */
  it('keeps the word-scorer’s opinion without acting on it', () => {
    const inferred = classifyLead({ name: 'Srdjan Todić' });
    const result = assertClassification({
      label: 'FACADE_CONTRACTOR',
      reason: 'listed under gradjevinski-radovi/fasader',
      inferred,
    });

    // The exact shape of the problem this mechanism solves.
    expect(inferred.label).toBe('UNKNOWN');
    expect(result.label).toBe('FACADE_CONTRACTOR');
    expect(result.inferred?.label).toBe('UNKNOWN');
  });

  it('omits `inferred` when the caller did not run the scorer', () => {
    const result = assertClassification({ label: 'FACADE_CONTRACTOR', reason: 'a category' });
    expect(result.inferred).toBeUndefined();
  });
});

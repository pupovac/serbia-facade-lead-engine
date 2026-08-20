import { describe, expect, it } from 'vitest';
import { scoreLead } from './score.js';
import { MAX_SCORE, NO_PHONE_CEILING, SCORE_WEIGHTS } from './weights.js';
import type { ScoreInput } from './types.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const YESTERDAY = new Date('2026-08-19T12:00:00Z');

function lead(overrides: ScoreInput = {}): ScoreInput {
  return { lastSeenAt: YESTERDAY, now: NOW, ...overrides };
}

describe('the weight table', () => {
  it('sums to exactly 100, so a weight is also a percentage', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b);
    expect(total).toBe(MAX_SCORE);
  });

  it('makes the phone the single largest component', () => {
    const others = Object.entries(SCORE_WEIGHTS)
      .filter(([k]) => k !== 'phone')
      .map(([, v]) => v);
    for (const weight of others) expect(SCORE_WEIGHTS.phone).toBeGreaterThan(weight);
  });
});

describe('scoreLead — a phone is the deliverable', () => {
  it('scores a lead with a phone and nothing else well above zero', () => {
    const result = scoreLead(lead({ phones: [{ e164: '+381641234567', type: 'mobile' }] }));
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.capped).toBe(false);
  });

  it('scores a name-and-city lead with no phone near the floor', () => {
    const result = scoreLead(
      lead({
        city: { confidence: 1, matchedVia: 'exact' },
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.9 },
      }),
    );
    expect(result.score).toBeLessThanOrEqual(NO_PHONE_CEILING);
  });

  it('ranks every lead with a phone above every lead without one', () => {
    const richButUnreachable = scoreLead(
      lead({
        emails: ['info@fasade.rs'],
        websites: ['https://fasade.rs'],
        socials: ['https://facebook.com/fasade'],
        city: { confidence: 1, matchedVia: 'exact' },
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.95 },
        sourceIds: ['portal-srbija', 'navidiku', '011info'],
      }),
    );
    const bareButReachable = scoreLead(lead({ phones: [{ e164: '+381641234567' }] }));

    expect(richButUnreachable.capped).toBe(true);
    expect(bareButReachable.score).toBeGreaterThan(richButUnreachable.score);
  });

  it('records the cap as a component instead of silently truncating', () => {
    const result = scoreLead(
      lead({
        emails: ['a@b.rs'],
        websites: ['https://b.rs'],
        socials: ['https://facebook.com/b'],
        city: { confidence: 1, matchedVia: 'exact' },
        classification: { label: 'BOTH', confidence: 1 },
        sourceIds: ['a', 'b', 'c'],
      }),
    );
    const cap = result.components.find((c) => c.id === 'noPhoneCeiling');
    expect(cap).toBeDefined();
    expect(cap?.points).toBeLessThan(0);
    expect(cap?.detail).toContain('no phone');
  });

  it('does not pay for an invalid or duplicate number', () => {
    const duplicated = scoreLead(
      lead({
        phones: [
          { e164: '+381641234567', type: 'mobile' },
          { e164: '+381641234567', type: 'mobile' },
        ],
      }),
    );
    const single = scoreLead(lead({ phones: [{ e164: '+381641234567', type: 'mobile' }] }));
    expect(duplicated.score).toBe(single.score);

    // A number kept for auditing is still not a number anyone can dial.
    const invalidOnly = scoreLead(lead({ phones: [{ e164: '+381640000000', valid: false }] }));
    expect(invalidOnly.components.find((c) => c.id === 'phone')?.points).toBe(0);
    expect(invalidOnly.components.find((c) => c.id === 'phone')?.detail).toBe('no phone');
    expect(invalidOnly.score).toBeLessThanOrEqual(NO_PHONE_CEILING);
  });

  it('pays a little more for a second number and for a mobile', () => {
    const oneLandline = scoreLead(lead({ phones: [{ e164: '+381114065142', type: 'landline' }] }));
    const landlineAndMobile = scoreLead(
      lead({
        phones: [
          { e164: '+381114065142', type: 'landline' },
          { e164: '+381641234567', type: 'mobile' },
        ],
      }),
    );
    expect(landlineAndMobile.score).toBeGreaterThan(oneLandline.score);
  });
});

describe('scoreLead — the other components', () => {
  it('scales the city component by how the city was resolved', () => {
    const stated = scoreLead(
      lead({ phones: [{ e164: '+381641234567' }], city: { confidence: 1, matchedVia: 'exact' } }),
    );
    const guessedFromLandline = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        city: { confidence: 0.35, matchedVia: 'landline' },
      }),
    );
    const none = scoreLead(lead({ phones: [{ e164: '+381641234567' }] }));

    expect(stated.score).toBeGreaterThan(guessedFromLandline.score);
    expect(guessedFromLandline.score).toBeGreaterThan(none.score);
  });

  it('gives an UNKNOWN classification nothing', () => {
    const unknown = scoreLead(
      lead({ phones: [{ e164: '+381641234567' }], classification: { label: 'UNKNOWN' } }),
    );
    const known = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        classification: { label: 'FACADE_CONTRACTOR', confidence: 1 },
      }),
    );
    expect(unknown.components.find((c) => c.id === 'classification')?.points).toBe(0);
    expect(known.score - unknown.score).toBe(SCORE_WEIGHTS.classification);
  });

  it('does not rank BOTH above a single label — it is not a better lead', () => {
    const one = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        classification: { label: 'CONSTRUCTION_MATERIAL_STORE', confidence: 0.9 },
      }),
    );
    const both = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        classification: { label: 'BOTH', confidence: 0.9 },
      }),
    );
    expect(both.score).toBe(one.score);
  });

  it('pays for corroboration by independent sources', () => {
    const scores = [1, 2, 3, 4].map(
      (n) =>
        scoreLead(
          lead({
            phones: [{ e164: '+381641234567' }],
            sourceIds: Array.from({ length: n }, (_, i) => `source-${i}`),
          }),
        ).score,
    );
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
    expect(scores[2]).toBeGreaterThan(scores[1] ?? 0);
    // Capped at three: a fourth directory says nothing new.
    expect(scores[3]).toBe(scores[2]);
  });

  it('decays recency and floors it at a year', () => {
    const fresh = scoreLead(
      lead({ phones: [{ e164: '+381641234567' }], lastSeenAt: YESTERDAY, now: NOW }),
    );
    const halfYear = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        lastSeenAt: new Date('2026-02-20T12:00:00Z'),
        now: NOW,
      }),
    );
    const ancient = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        lastSeenAt: new Date('2019-04-13T00:00:00Z'),
        now: NOW,
      }),
    );
    expect(fresh.score).toBeGreaterThan(halfYear.score);
    expect(halfYear.score).toBeGreaterThan(ancient.score);
    expect(ancient.components.find((c) => c.id === 'recency')?.points).toBe(0);
  });
});

describe('scoreLead — output contract', () => {
  it('orders representative leads the way a call list should be ordered', () => {
    const leads: readonly [string, ScoreInput][] = [
      [
        'complete contractor, three sources',
        lead({
          phones: [
            { e164: '+381641234567', type: 'mobile' },
            { e164: '+381114065142', type: 'landline' },
          ],
          emails: ['info@fasade.rs'],
          websites: ['https://fasade.rs'],
          socials: ['https://facebook.com/fasade'],
          city: { confidence: 1, matchedVia: 'exact' },
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.95 },
          sourceIds: ['portal-srbija', 'navidiku', '011info'],
        }),
      ],
      [
        'classified store, phone and website',
        lead({
          phones: [{ e164: '+381214065142', type: 'landline' }],
          websites: ['https://stovariste.rs'],
          city: { confidence: 1, matchedVia: 'exact' },
          classification: { label: 'CONSTRUCTION_MATERIAL_STORE', confidence: 0.9 },
          sourceIds: ['austrotherm'],
        }),
      ],
      [
        'sole trader, mobile and a city guessed from the number',
        lead({
          phones: [{ e164: '+381641234567', type: 'mobile' }],
          city: { confidence: 0.35, matchedVia: 'landline' },
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.7 },
          sourceIds: ['poslovni-kontakt'],
        }),
      ],
      ['phone only, unclassified', lead({ phones: [{ e164: '+381641234567' }] })],
      [
        'no phone, everything else',
        lead({
          emails: ['info@firma.rs'],
          websites: ['https://firma.rs'],
          city: { confidence: 1, matchedVia: 'exact' },
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.95 },
          sourceIds: ['portal-srbija', 'navidiku'],
        }),
      ],
    ];

    const scored = leads.map(([name, input]) => ({ name, score: scoreLead(input).score }));
    expect(scored.map((s) => s.name)).toStrictEqual(
      [...scored].sort((a, b) => b.score - a.score).map((s) => s.name),
    );
    // And the gaps are real, not rounding noise.
    for (let i = 1; i < scored.length; i += 1) {
      expect(scored[i - 1]?.score).toBeGreaterThan(scored[i]?.score ?? 0);
    }
  });

  it('stays inside 0–100 and returns an integer', () => {
    const everything = scoreLead(
      lead({
        phones: [
          { e164: '+381641234567', type: 'mobile' },
          { e164: '+381114065142', type: 'landline' },
          { e164: '+381211234567', type: 'landline' },
          { e164: '+381601234567', type: 'mobile' },
        ],
        emails: ['a@b.rs', 'c@d.rs'],
        websites: ['https://b.rs'],
        socials: ['https://facebook.com/b', 'https://instagram.com/b'],
        city: { confidence: 1, matchedVia: 'exact' },
        classification: { label: 'BOTH', confidence: 1 },
        sourceIds: ['a', 'b', 'c', 'd'],
        lastSeenAt: NOW,
        now: NOW,
      }),
    );
    expect(everything.score).toBe(MAX_SCORE);
    expect(Number.isInteger(everything.score)).toBe(true);
    expect(scoreLead({}).score).toBeGreaterThanOrEqual(0);
  });

  it('explains every point it awarded', () => {
    const result = scoreLead(lead({ phones: [{ e164: '+381641234567', type: 'mobile' }] }));
    const fromComponents = result.components.reduce((sum, c) => sum + c.points, 0);
    expect(Math.round(fromComponents)).toBe(result.score);
    for (const component of result.components) {
      expect(component.detail.length).toBeGreaterThan(0);
    }
  });

  it('is pure', () => {
    const input = lead({ phones: [{ e164: '+381641234567', type: 'mobile' }] });
    expect(scoreLead(input)).toStrictEqual(scoreLead(input));
  });

  it('does not penalise a caller that keeps no clock', () => {
    const withoutTime = scoreLead({ phones: [{ e164: '+381641234567' }] });
    expect(withoutTime.components.find((c) => c.id === 'recency')?.points).toBe(
      SCORE_WEIGHTS.recency,
    );
  });
});

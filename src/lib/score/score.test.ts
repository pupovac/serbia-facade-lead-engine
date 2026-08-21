import { describe, expect, it } from 'vitest';
import { scoreLead, scoreRelevance } from './score.js';
import {
  CONTACTABILITY_WEIGHTS,
  MAX_SCORE,
  NO_PHONE_CEILING,
  RELEVANCE_WEIGHTS,
} from './weights.js';
import type { ScoreInput } from './types.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const YESTERDAY = new Date('2026-08-19T12:00:00Z');

function lead(overrides: ScoreInput = {}): ScoreInput {
  return { lastSeenAt: YESTERDAY, now: NOW, ...overrides };
}

describe('the weight tables', () => {
  it('each sum to exactly 100, so a weight is also a percentage', () => {
    for (const table of [CONTACTABILITY_WEIGHTS, RELEVANCE_WEIGHTS]) {
      expect(Object.values(table).reduce((a: number, b: number) => a + b)).toBe(MAX_SCORE);
    }
  });

  it('makes the phone the single largest contactability component', () => {
    const others = Object.entries(CONTACTABILITY_WEIGHTS)
      .filter(([k]) => k !== 'phone')
      .map(([, v]) => v);
    for (const weight of others) expect(CONTACTABILITY_WEIGHTS.phone).toBeGreaterThan(weight);
  });

  it('lets no contact channel into the relevance table', () => {
    // The guarantee this issue exists to make. If a key ever appears here that
    // names a way of reaching a business, relevance has started measuring
    // completeness again.
    expect(Object.keys(RELEVANCE_WEIGHTS).sort()).toStrictEqual([
      'confidence',
      'evidence',
      'label',
    ]);
  });
});

describe('scoreLead — a phone is the deliverable', () => {
  it('scores a lead with a phone and nothing else well above zero', () => {
    const result = scoreLead(lead({ phones: [{ e164: '+381641234567', type: 'mobile' }] }));
    expect(result.contactability).toBeGreaterThanOrEqual(40);
    expect(result.capped).toBe(false);
  });

  it('scores a name-and-city lead with no phone near the floor', () => {
    const result = scoreLead(
      lead({
        city: { confidence: 1, matchedVia: 'exact' },
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.9 },
      }),
    );
    expect(result.contactability).toBeLessThanOrEqual(NO_PHONE_CEILING);
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
    expect(bareButReachable.contactability).toBeGreaterThan(richButUnreachable.contactability);
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
    expect(duplicated.contactability).toBe(single.contactability);

    // A number kept for auditing is still not a number anyone can dial.
    const invalidOnly = scoreLead(lead({ phones: [{ e164: '+381640000000', valid: false }] }));
    expect(invalidOnly.components.find((c) => c.id === 'phone')?.points).toBe(0);
    expect(invalidOnly.components.find((c) => c.id === 'phone')?.detail).toBe('no phone');
    expect(invalidOnly.contactability).toBeLessThanOrEqual(NO_PHONE_CEILING);
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
    expect(landlineAndMobile.contactability).toBeGreaterThan(oneLandline.contactability);
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

    expect(stated.contactability).toBeGreaterThan(guessedFromLandline.contactability);
    expect(guessedFromLandline.contactability).toBeGreaterThan(none.contactability);
  });

  it('lets no label change the contactability score', () => {
    const labels = [
      'UNCLASSIFIED',
      'OUT_OF_SCOPE',
      'FACADE_CONTRACTOR',
      'CONSTRUCTION_MATERIAL_STORE',
      'BOTH',
    ] as const;
    const scores = labels.map(
      (label) =>
        scoreLead(
          lead({
            phones: [{ e164: '+381641234567' }],
            classification: { label, confidence: 0.9, evidenceNet: 1.4 },
          }),
        ).contactability,
    );
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBeGreaterThan(0);
  });

  it('does not rank BOTH above a single label — it is not a better lead', () => {
    const one = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        classification: {
          label: 'CONSTRUCTION_MATERIAL_STORE',
          confidence: 0.9,
          evidenceNet: 1.2,
        },
      }),
    );
    const both = scoreLead(
      lead({
        phones: [{ e164: '+381641234567' }],
        classification: { label: 'BOTH', confidence: 0.9, evidenceNet: 1.2 },
      }),
    );
    expect(both.relevance).toBe(one.relevance);
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
        ).contactability,
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
    expect(fresh.contactability).toBeGreaterThan(halfYear.contactability);
    expect(halfYear.contactability).toBeGreaterThan(ancient.contactability);
    expect(ancient.components.find((c) => c.id === 'recency')?.points).toBe(0);
  });
});

describe('scoreRelevance — is this a lead for us', () => {
  const contractor = { label: 'FACADE_CONTRACTOR', confidence: 0.9, evidenceNet: 1.5 } as const;

  it('gives two leads with identical evidence and different contact cards the same relevance', () => {
    // The acceptance criterion of FUZZ-37, stated as a test. `Garaza Banovina`
    // scored 76 because it had two phones, an email, a website and a social
    // profile; nothing below may ever move this number.
    const bare = scoreLead(lead({ classification: contractor }));
    const documented = scoreLead(
      lead({
        classification: contractor,
        phones: [
          { e164: '+381641234567', type: 'mobile' },
          { e164: '+381114065142', type: 'landline' },
        ],
        emails: ['info@fasade.rs'],
        websites: ['https://fasade.rs'],
        socials: ['https://facebook.com/fasade'],
        city: { confidence: 1, matchedVia: 'exact' },
        sourceIds: ['portal-srbija', 'navidiku', '011info'],
      }),
    );

    expect(bare.relevance).toBe(documented.relevance);
    expect(bare.relevanceComponents).toStrictEqual(documented.relevanceComponents);
    // ...and the two are genuinely different leads on the other axis.
    expect(documented.contactability).toBeGreaterThan(bare.contactability);
  });

  it('scores an undecided lead zero however complete its contact card is', () => {
    for (const label of ['UNCLASSIFIED', 'OUT_OF_SCOPE'] as const) {
      const result = scoreLead(
        lead({
          classification: { label, confidence: 0.95 },
          phones: [
            { e164: '+381641234567', type: 'mobile' },
            { e164: '+381114065142', type: 'landline' },
          ],
          emails: ['office@garaza.rs'],
          websites: ['https://garaza.rs'],
          socials: ['https://facebook.com/garaza'],
          city: { confidence: 1, matchedVia: 'exact' },
          sourceIds: ['a', 'b', 'c'],
        }),
      );
      expect(result.relevance, label).toBe(0);
      // Confidence in *not* being a lead must not be paid for either.
      for (const component of result.relevanceComponents) {
        expect(component.points, `${label}/${component.id}`).toBe(0);
      }
      expect(result.score, label).toBe(0);
      expect(result.contactability, label).toBeGreaterThan(80);
    }
  });

  it('pays more for stronger evidence behind the same label', () => {
    const barely = scoreRelevance({ ...contractor, confidence: 0.52, evidenceNet: 0.95 });
    const solid = scoreRelevance({ ...contractor, confidence: 0.98, evidenceNet: 2.4 });
    expect(solid.score).toBeGreaterThan(barely.score);
    expect(barely.score).toBeGreaterThan(0);
  });

  it('falls back to the confidence when the arithmetic was not stored', () => {
    // An old row with no `classification_evidence` still has a label and a
    // confidence; it is graded on those rather than punished for the gap.
    const withoutNet = scoreRelevance({ label: 'BOTH', confidence: 0.98 });
    expect(withoutNet.score).toBe(MAX_SCORE);
    expect(withoutNet.components.find((c) => c.id === 'evidence')?.detail).toContain('not stored');
  });

  it('treats a missing classification as unclassified rather than throwing', () => {
    expect(scoreRelevance(undefined).score).toBe(0);
    expect(scoreLead({}).relevance).toBe(0);
  });
});

describe('lead_score — the one derived sort key', () => {
  it('is relevance times contactability, so relevance gates and contactability ranks', () => {
    const result = scoreLead(
      lead({
        phones: [{ e164: '+381641234567', type: 'mobile' }],
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.9, evidenceNet: 1.5 },
      }),
    );
    expect(result.score).toBe(Math.round((result.relevance * result.contactability) / MAX_SCORE));
  });

  it('ranks a documented irrelevant business below every real lead', () => {
    // The defect, as it appeared in the pilot: a parking garage with two
    // phones, an email, a website and a social profile scored 76/100.
    const parkingGarage = scoreLead(
      lead({
        classification: { label: 'UNCLASSIFIED', confidence: 0.93 },
        phones: [
          { e164: '+381214065142', type: 'landline' },
          { e164: '+381641234567', type: 'mobile' },
        ],
        emails: ['office@garaza.rs'],
        websites: ['https://garaza.rs'],
        socials: ['https://facebook.com/garaza'],
        city: { confidence: 1, matchedVia: 'exact' },
        sourceIds: ['overture-places', 'portal-srbija'],
      }),
    );
    const soleTraderWithAMobile = scoreLead(
      lead({
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.62, evidenceNet: 1.1 },
        phones: [{ e164: '+381641234567', type: 'mobile' }],
      }),
    );

    expect(parkingGarage.contactability).toBeGreaterThan(soleTraderWithAMobile.contactability);
    expect(parkingGarage.score).toBeLessThan(soleTraderWithAMobile.score);
    expect(parkingGarage.score).toBe(0);
  });
});

describe('scoreLead — output contract', () => {
  it('orders representative leads by contactability the way a call list should be', () => {
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
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.95, evidenceNet: 2 },
          sourceIds: ['portal-srbija', 'navidiku', '011info'],
        }),
      ],
      [
        'classified store, phone and website',
        lead({
          phones: [{ e164: '+381214065142', type: 'landline' }],
          websites: ['https://stovariste.rs'],
          city: { confidence: 1, matchedVia: 'exact' },
          classification: {
            label: 'CONSTRUCTION_MATERIAL_STORE',
            confidence: 0.9,
            evidenceNet: 1.5,
          },
          sourceIds: ['austrotherm'],
        }),
      ],
      [
        'sole trader, mobile and a city guessed from the number',
        lead({
          phones: [{ e164: '+381641234567', type: 'mobile' }],
          city: { confidence: 0.35, matchedVia: 'landline' },
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.7, evidenceNet: 1.2 },
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
          classification: { label: 'FACADE_CONTRACTOR', confidence: 0.95, evidenceNet: 2 },
          sourceIds: ['portal-srbija', 'navidiku'],
        }),
      ],
    ];

    const scored = leads.map(([name, input]) => ({
      name,
      score: scoreLead(input).contactability,
    }));
    expect(scored.map((s) => s.name)).toStrictEqual(
      [...scored].sort((a, b) => b.score - a.score).map((s) => s.name),
    );
    // And the gaps are real, not rounding noise.
    for (let i = 1; i < scored.length; i += 1) {
      expect(scored[i - 1]?.score).toBeGreaterThan(scored[i]?.score ?? 0);
    }
  });

  it('stays inside 0–100 and returns integers on all three numbers', () => {
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
        classification: { label: 'BOTH', confidence: 1, evidenceNet: 3 },
        sourceIds: ['a', 'b', 'c', 'd'],
        lastSeenAt: NOW,
        now: NOW,
      }),
    );
    expect(everything.contactability).toBe(MAX_SCORE);
    expect(everything.relevance).toBe(MAX_SCORE);
    expect(everything.score).toBe(MAX_SCORE);
    for (const value of [everything.score, everything.relevance, everything.contactability]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    const empty = scoreLead({});
    expect(empty.score).toBeGreaterThanOrEqual(0);
    expect(empty.relevance).toBe(0);
  });

  it('explains every point it awarded, on both axes', () => {
    const result = scoreLead(
      lead({
        phones: [{ e164: '+381641234567', type: 'mobile' }],
        classification: { label: 'FACADE_CONTRACTOR', confidence: 0.9, evidenceNet: 1.5 },
      }),
    );
    expect(Math.round(result.components.reduce((sum, c) => sum + c.points, 0))).toBe(
      result.contactability,
    );
    expect(Math.round(result.relevanceComponents.reduce((sum, c) => sum + c.points, 0))).toBe(
      result.relevance,
    );
    for (const component of [...result.components, ...result.relevanceComponents]) {
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
      CONTACTABILITY_WEIGHTS.recency,
    );
  });
});

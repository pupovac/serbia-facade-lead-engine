/**
 * `veleprodaja` alone does not make a stovarište.
 *
 * Every lead in the FUZZ-22 pilot whose `CONSTRUCTION_MATERIAL_STORE` label
 * rested on that one word was wrong — all eight of them. They sell carpets,
 * circuit breakers, hand tools, spare parts for excavators, traffic cones and
 * aluminium profiles. The classifier already knew the signal was weak: it
 * demoted it from `core` to `supporting` whenever the record named no building
 * material. It just kept the full 0.95 weight while doing it, and a
 * `supporting` 0.95 clears `DECISION_THRESHOLD` on its own, so the demotion
 * changed the evidence trail and nothing in the arithmetic.
 *
 * The three yards at the bottom are the other half of the test. `Domino` and
 * `Montel` stock PVC joinery and `Preduzeće Čar` says `veleprodajom` in its own
 * prose — a blanket joinery penalty on the store axis, or a blanket distrust of
 * `veleprodaja`, would take their labels away. The fix has to be narrow enough
 * to leave them alone, and this file is where that stays true.
 */
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/veleprodaja-only.json' with { type: 'json' };
import { classifyLead } from './classify.js';
import { NO_ASSORTMENT_DISCOUNT } from './signals.js';
import type { ClassificationInput } from './types.js';

interface FixtureLead {
  readonly leadId: number;
  readonly name: string;
  readonly city: string | null;
  readonly description: string;
  readonly categories: readonly string[];
  readonly sells?: string;
  readonly note?: string;
}

const WHOLESALERS = fixture.wholesalers_of_something_else as readonly FixtureLead[];
const YARDS = fixture.genuine_yards as readonly FixtureLead[];

function toInput(lead: FixtureLead): ClassificationInput {
  return {
    name: lead.name,
    ...(lead.description === '' ? {} : { description: lead.description }),
    ...(lead.categories.length === 0 ? {} : { categories: lead.categories }),
  };
}

describe('wholesalers of something that is not building material', () => {
  it('has all eight of the pilot leads the issue names', () => {
    expect(WHOLESALERS).toHaveLength(8);
    expect(WHOLESALERS.map((l) => l.leadId).sort((a, b) => a - b)).toStrictEqual([
      257, 262, 1931, 2808, 2840, 3422, 3457, 3616,
    ]);
  });

  it.each(WHOLESALERS.map((l): [string, FixtureLead] => [`${l.leadId} ${l.name}`, l]))(
    'does not label %s a construction-material store',
    (_label, lead) => {
      expect(classifyLead(toInput(lead)).label, `${lead.name} sells ${lead.sells}`).not.toBe(
        'CONSTRUCTION_MATERIAL_STORE',
      );
    },
  );

  it('does not quietly relabel them a facade contractor instead', () => {
    for (const lead of WHOLESALERS) {
      expect(classifyLead(toInput(lead)).label, lead.name).not.toBe('FACADE_CONTRACTOR');
      expect(classifyLead(toInput(lead)).label, lead.name).not.toBe('BOTH');
    }
  });

  it('still records the word it found, discounted and marked', () => {
    // The signal is not deleted — it is priced. A reviewer opening the lead has
    // to be able to see that `veleprodaja` was read and what it was worth.
    const evrometal = WHOLESALERS.find((l) => l.leadId === 1931);
    expect(evrometal).toBeDefined();
    const result = classifyLead(toInput(evrometal as FixtureLead));
    const wholesale = result.evidence.find((e) => e.signalId === 'store.veleprodaja');
    expect(wholesale).toBeDefined();
    expect(wholesale?.strength).toBe('supporting');
    expect(wholesale?.discountedFor).toBe('no-assortment');
    expect(wholesale?.weight).toBeCloseTo((wholesale?.fullWeight ?? 0) * NO_ASSORTMENT_DISCOUNT, 3);
    expect(result.store.net).toBeLessThan(0.9);
  });

  it('discounts the word in a company name too, where it weighs 2.5x', () => {
    // `EURO-PROFIL Veleprodaja` is the hard case: 0.95 x 2.5 = 2.375 before the
    // discount, nearly three times the threshold.
    const euroProfil = WHOLESALERS.find((l) => l.leadId === 257);
    expect(euroProfil).toBeDefined();
    const result = classifyLead(toInput(euroProfil as FixtureLead));
    const wholesale = result.evidence.find((e) => e.signalId === 'store.veleprodaja');
    expect(wholesale?.field).toBe('name');
    expect(wholesale?.fullWeight).toBeCloseTo(2.375, 3);
    expect(result.label).not.toBe('CONSTRUCTION_MATERIAL_STORE');
  });
});

describe('the yards the fix must not touch', () => {
  it.each(YARDS.map((l): [string, FixtureLead] => [`${l.leadId} ${l.name}`, l]))(
    'keeps %s a construction-material store',
    (_label, lead) => {
      expect(classifyLead(toInput(lead)).label, lead.note).toBe('CONSTRUCTION_MATERIAL_STORE');
    },
  );

  it('leaves `veleprodaja` at full weight when the record names a material', () => {
    // Preduzeće Čar publishes both the word and the assortment. The word is
    // only ever discounted for saying nothing about what is being sold.
    const car = YARDS.find((l) => l.leadId === 2532);
    expect(car).toBeDefined();
    const result = classifyLead(toInput(car as FixtureLead));
    expect(result.store.assortment).toBeGreaterThan(0);
    const wholesale = result.evidence.find((e) => e.signalId === 'store.veleprodaja');
    expect(wholesale?.discountedFor).toBeUndefined();
    expect(wholesale?.strength).toBe('core');
  });

  it('keeps a yard that also stocks joinery, joinery evidence and all', () => {
    // The reason (b) in the issue — penalising joinery on the store axis — was
    // left alone: these three would have lost their labels to it.
    const withJoinery = YARDS.filter((lead) =>
      classifyLead(toInput(lead)).evidence.some((e) => e.industry === 'joinery'),
    );
    expect(withJoinery.length).toBeGreaterThan(0);
    for (const lead of withJoinery) {
      expect(classifyLead(toInput(lead)).label, lead.name).toBe('CONSTRUCTION_MATERIAL_STORE');
    }
  });
});

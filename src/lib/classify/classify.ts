/**
 * Lead classification: `FACADE_CONTRACTOR` | `CONSTRUCTION_MATERIAL_STORE` |
 * `BOTH` | `UNKNOWN`, with the evidence that produced it.
 *
 * The matcher does three things, in this order:
 *
 * 1. Finds every signal in every field.
 * 2. Resolves overlaps **longest span first**. `čišćenje fasada` outranks
 *    `fasada`; `fasadna stolarija` outranks `fasadn…`; `fasadni materijal`
 *    outranks it too and argues for the store instead. The losing signal is
 *    reported in `suppressed`, because "why is this facade company UNKNOWN"
 *    is the question a reviewer actually asks.
 * 3. Scores each axis behind a gate. Nothing becomes a facade contractor
 *    without a facade term, however much `termoizolacija` it publishes, and
 *    nothing becomes a store without either a selling term or a wide enough
 *    materials assortment.
 *
 * `BOTH` is not a tie-break — it is what happens when both axes clear the
 * threshold on their own, which is the normal state of a stovarište that also
 * installs.
 */
import { foldForComparison } from '../text/fold.js';
import {
  ASSORTMENT_BONUS,
  ASSORTMENT_GATE,
  DECISION_THRESHOLD,
  FIELD_WEIGHTS,
  SIGNALS,
} from './signals.js';
import type {
  AxisBreakdown,
  ClassificationEvidence,
  ClassificationField,
  ClassificationInput,
  ClassificationResult,
  LeadClassification,
  Signal,
  SuppressedMatch,
} from './types.js';

interface RawMatch {
  readonly signal: Signal;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface FieldText {
  readonly field: ClassificationField;
  readonly text: string;
}

/** A URL is only useful here as words: `www.krecenje-beograd.rs` → `krecenje beograd rs`. */
function urlToWords(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/[^\p{L}\p{N}]+/gu, ' ');
}

function fieldTexts(input: ClassificationInput): FieldText[] {
  const out: FieldText[] = [];
  const push = (field: ClassificationField, raw: string | undefined): void => {
    if (raw === undefined) return;
    const text = foldForComparison(raw);
    if (text.length > 0) out.push({ field, text });
  };
  push('name', input.name);
  for (const category of input.categories ?? []) push('category', category);
  push('description', input.description);
  push('website', input.website === undefined ? undefined : urlToWords(input.website));
  push('websiteText', input.websiteText);
  return out;
}

function collect(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      // The table's regexes are module-level and global; reset before each use.
      pattern.lastIndex = 0;
      let hit: RegExpExecArray | null = pattern.exec(text);
      while (hit !== null) {
        matches.push({ signal, start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
        if (hit[0].length === 0) pattern.lastIndex += 1;
        hit = pattern.exec(text);
      }
    }
  }
  return matches;
}

interface Resolved {
  readonly claimed: RawMatch[];
  readonly suppressed: SuppressedMatch[];
}

/**
 * Longest span wins the text under it.
 *
 * Ties break on the earlier start, then on the signal id, so the result is
 * stable across runs — an unstable evidence trail is not an evidence trail.
 */
function resolveOverlaps(matches: readonly RawMatch[], field: ClassificationField): Resolved {
  const ordered = [...matches].sort((a, b) => {
    const byLength = b.end - b.start - (a.end - a.start);
    if (byLength !== 0) return byLength;
    // Same span, two readings: `fasaderski` is both `fasader` and `fasad…`.
    // The heavier signal is the more specific one, so it wins the span.
    if (a.signal.weight !== b.signal.weight) return b.signal.weight - a.signal.weight;
    if (a.start !== b.start) return a.start - b.start;
    return a.signal.id.localeCompare(b.signal.id);
  });

  const claimed: RawMatch[] = [];
  const suppressed: SuppressedMatch[] = [];
  const taken: { start: number; end: number; by: RawMatch }[] = [];

  for (const match of ordered) {
    const overlap = taken.find((t) => match.start < t.end && t.start < match.end);
    if (overlap === undefined) {
      claimed.push(match);
      taken.push({ start: match.start, end: match.end, by: match });
      continue;
    }
    // Only report a suppression that changed the reading — a longer phrase of
    // the same signal is bookkeeping, not a decision.
    if (overlap.by.signal.id !== match.signal.id) {
      suppressed.push({
        field,
        matched: overlap.by.text,
        claimedBy: overlap.by.signal.id,
        suppressed: match.signal.id,
      });
    }
  }
  return { claimed, suppressed };
}

/**
 * `core + max(0, supporting + ambiguousCredit − penalty)`.
 *
 * The cap on `ambiguousCredit` is the rule the brief asks for in so many words:
 * score the *combination*, not the keyword. `termoizolacija`, `izolacija` and a
 * bare `fasada` corroborate evidence that already exists and contribute nothing
 * when it does not — so a roofing company that mentions thermal insulation four
 * times still scores zero on the contractor axis.
 */
function axisNet(axis: {
  core: number;
  supporting: number;
  ambiguous: number;
  penalty: number;
  gateOpen: boolean;
}): { net: number; ambiguousCredit: number } {
  const ambiguousCredit = Math.min(axis.ambiguous, axis.core + axis.supporting);
  if (!axis.gateOpen) return { net: 0, ambiguousCredit };
  return {
    net: axis.core + Math.max(0, axis.supporting + ambiguousCredit - axis.penalty),
    ambiguousCredit,
  };
}

function confidenceFor(net: number): number {
  return Math.min(0.98, 0.5 + 0.45 * Math.min(1, (net - DECISION_THRESHOLD) / DECISION_THRESHOLD));
}

function describe(
  evidence: readonly ClassificationEvidence[],
  axis: 'contractor' | 'store',
): string {
  const top = evidence
    .filter((e) => e.axis === axis)
    .slice(0, 3)
    .map((e) => `\`${e.matched}\` (${e.field})`);
  return top.length === 0 ? 'no evidence' : top.join(', ');
}

/**
 * Classify one lead from whatever text the sources published about it.
 *
 * Pure: same input, same result, no clock and no I/O.
 */
export function classifyLead(input: ClassificationInput): ClassificationResult {
  const evidence: ClassificationEvidence[] = [];
  const suppressed: SuppressedMatch[] = [];
  const contractor = { core: 0, supporting: 0, ambiguous: 0, penalty: 0, gateOpen: false };
  const store = { core: 0, supporting: 0, ambiguous: 0, penalty: 0, gateOpen: false };
  const assortmentSignals = new Set<string>();
  /** Weight of the disqualifiers that re-read the facade word itself. */
  let coreCancel = 0;
  let manufacturerFound = false;
  let retailCoreFound = false;
  /** Scored last: their strength depends on whether any materials were found. */
  const pendingAssortmentDependent: { signal: Signal; weight: number }[] = [];

  for (const { field, text } of fieldTexts(input)) {
    const resolved = resolveOverlaps(collect(text), field);
    suppressed.push(...resolved.suppressed);

    // One score per (signal, field): a catalogue repeating `stiropor` eight
    // times is one fact about the business, not eight.
    const bySignal = new Map<string, { signal: Signal; first: RawMatch; occurrences: number }>();
    for (const match of resolved.claimed) {
      const seen = bySignal.get(match.signal.id);
      if (seen === undefined) {
        bySignal.set(match.signal.id, { signal: match.signal, first: match, occurrences: 1 });
        continue;
      }
      seen.occurrences += 1;
      if (match.start < seen.first.start) {
        bySignal.set(match.signal.id, { ...seen, first: match });
      }
    }

    for (const { signal, first, occurrences } of bySignal.values()) {
      const weight = signal.weight * FIELD_WEIGHTS[field];
      evidence.push({
        signalId: signal.id,
        axis: signal.axis,
        strength: signal.strength,
        field,
        matched: first.text,
        weight: Math.round(weight * 1000) / 1000,
        occurrences,
        ...(signal.industry === undefined ? {} : { industry: signal.industry }),
      });

      if (signal.axis === 'adjacent') {
        for (const target of signal.suppresses ?? []) {
          const bucket = target === 'contractor' ? contractor : store;
          bucket.penalty += weight;
        }
        if (signal.cancelsCore === true) coreCancel += weight;
        if (signal.industry === 'manufacturing') manufacturerFound = true;
        continue;
      }

      const bucket = signal.axis === 'contractor' ? contractor : store;
      if (signal.needsAssortment === true) pendingAssortmentDependent.push({ signal, weight });
      else if (signal.strength === 'core') bucket.core += weight;
      else if (signal.strength === 'supporting') bucket.supporting += weight;
      else bucket.ambiguous += weight;

      if (signal.gate === 'facade' && signal.axis === 'contractor') contractor.gateOpen = true;
      if (signal.gate === 'retail' && signal.axis === 'store') {
        store.gateOpen = true;
        if (signal.strength === 'core') retailCoreFound = true;
      }
      if (signal.assortment === true) assortmentSignals.add(signal.id);
    }
  }

  // A wide enough assortment of building materials is itself a selling signal:
  // `Stiropor, stirodur, staklena vuna, kondor` names no verb and is obviously
  // a yard.
  const assortment = assortmentSignals.size;
  if (assortment >= ASSORTMENT_GATE) {
    store.gateOpen = true;
    store.supporting += ASSORTMENT_BONUS;
  }
  for (const { signal, weight } of pendingAssortmentDependent) {
    const bucket = signal.axis === 'contractor' ? contractor : store;
    const strength = assortment === 0 ? 'supporting' : signal.strength;
    if (strength === 'core') {
      bucket.core += weight;
      retailCoreFound = true;
    } else if (strength === 'supporting') bucket.supporting += weight;
    else bucket.ambiguous += weight;
  }

  // `alubond fasada` and `čišćenje fasada` do not sit next to the facade
  // evidence, they replace it — so they come off the core rather than off the
  // discountable part.
  const coreCancelled = Math.min(contractor.core, coreCancel);
  contractor.core -= coreCancelled;

  // A factory is a supplier, not a buyer. It only survives as a store when it
  // also names a counter — `stovarište`, `veleprodaja`, `farbara`.
  const vetoed = manufacturerFound && !retailCoreFound;
  if (vetoed) {
    contractor.gateOpen = false;
    store.gateOpen = false;
  }

  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const contractorNet = axisNet(contractor);
  const storeNet = axisNet(store);
  const contractorFinal: AxisBreakdown = {
    core: round(contractor.core),
    supporting: round(contractor.supporting),
    ambiguous: round(contractor.ambiguous),
    penalty: round(contractor.penalty),
    gateOpen: contractor.gateOpen,
    assortment: 0,
    net: round(contractorNet.net),
    ambiguousCredit: round(contractorNet.ambiguousCredit),
    coreCancelled: round(coreCancelled),
    ...(vetoed ? { vetoed: true } : {}),
  };
  const storeFinal: AxisBreakdown = {
    core: round(store.core),
    supporting: round(store.supporting),
    ambiguous: round(store.ambiguous),
    penalty: round(store.penalty),
    gateOpen: store.gateOpen,
    assortment,
    net: round(storeNet.net),
    ambiguousCredit: round(storeNet.ambiguousCredit),
    coreCancelled: 0,
    ...(vetoed ? { vetoed: true } : {}),
  };

  evidence.sort((a, b) => b.weight - a.weight || a.signalId.localeCompare(b.signalId));

  const isContractor = contractorFinal.net >= DECISION_THRESHOLD;
  const isStore = storeFinal.net >= DECISION_THRESHOLD;

  let label: LeadClassification;
  let confidence: number;
  let reason: string;
  if (isContractor && isStore) {
    label = 'BOTH';
    confidence = confidenceFor(Math.min(contractorFinal.net, storeFinal.net));
    reason = `Both axes cleared ${DECISION_THRESHOLD}: contractor ${contractorFinal.net} from ${describe(evidence, 'contractor')}; store ${storeFinal.net} from ${describe(evidence, 'store')}.`;
  } else if (isContractor) {
    label = 'FACADE_CONTRACTOR';
    confidence = confidenceFor(contractorFinal.net);
    reason = `Facade evidence ${contractorFinal.net} from ${describe(evidence, 'contractor')}; store evidence ${storeFinal.net}.`;
  } else if (isStore) {
    label = 'CONSTRUCTION_MATERIAL_STORE';
    confidence = confidenceFor(storeFinal.net);
    reason = `Store evidence ${storeFinal.net} from ${describe(evidence, 'store')}; facade evidence ${contractorFinal.net}.`;
  } else {
    label = 'UNKNOWN';
    const best = Math.max(contractorFinal.net, storeFinal.net);
    confidence = Math.min(
      0.98,
      0.5 + 0.45 * Math.min(1, (DECISION_THRESHOLD - best) / DECISION_THRESHOLD),
    );
    if (vetoed) {
      reason = 'Manufacturer: the record names production and no counter. A supplier, not a buyer.';
    } else if (coreCancelled > 0) {
      reason = `Facade wording belongs to another trade (${suppressed.map((x) => x.claimedBy).join(', ') || 'curtain wall or facade cleaning'}); ${round(coreCancelled)} of facade evidence cancelled.`;
    } else if (!contractorFinal.gateOpen && contractorFinal.ambiguous > 0) {
      reason = `No facade term — insulation wording alone (${contractorFinal.ambiguous}) does not make a facade contractor.`;
    } else {
      reason = `Neither axis reached ${DECISION_THRESHOLD}: contractor ${contractorFinal.net}, store ${storeFinal.net}.`;
    }
  }

  return {
    label,
    confidence: Math.round(confidence * 100) / 100,
    contractor: contractorFinal,
    store: storeFinal,
    evidence,
    suppressed,
    reason,
  };
}

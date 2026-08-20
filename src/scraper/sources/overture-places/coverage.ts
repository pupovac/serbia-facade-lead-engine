/**
 * Which municipality a place belongs to, and what each municipality yielded.
 *
 * This is the half of the adapter the issue actually asks a question of. A
 * geographic mechanism earns its keep in the small municipalities, where the
 * directories have the worst coverage, so "how many of the 145 local
 * self-government units did this reach" is the number that decides whether the
 * free stack is enough — and it is only knowable if every unit is walked,
 * including the ones that turn out to hold nothing.
 *
 * Assignment reads `src/lib/normalize/city`, the Data Engineer's resolver. It
 * is used here to decide **which scope a record is discovered under**, never to
 * fill a field: the `RawLead` still carries the locality string exactly as
 * Overture published it, and the pipeline resolves it again on the way to the
 * database, by the same rule, in the one place that owns it.
 */
import { municipalities, type Municipality } from '@/lib/geo';
import { resolveCity } from '@/lib/normalize';
import { QUERY_ARMS, armFor, type QueryArm } from './query.js';
import type { PlaceRow } from './place.js';

/** Records that named a place this project's geo dataset does not know. */
export const UNASSIGNED = 'unassigned';

/** The 145 local self-government units, largest and highest-priority first. */
export const coverageUnits: readonly Municipality[] = [...municipalities]
  .filter((unit) => unit.parent_id === null)
  .sort((a, b) => a.priority_tier - b.priority_tier || b.population - a.population);

export interface PlaceAssignment {
  /** Local self-government unit id, or `unassigned`. */
  readonly municipalityId: string;
  /** Most specific unit matched — a Belgrade city municipality, or the same as above. */
  readonly cityId: string | null;
  readonly arm: QueryArm;
}

/**
 * Locality plus postcode, resolved by `src/lib/normalize`.
 *
 * The postcode is prepended because it is the resolver's own tie-breaker for a
 * name it cannot place, and Overture carries one on nearly every Serbian
 * record. The first phone goes in as a hint for the same reason — it is the
 * resolver's documented last resort, and it is marked low-confidence there
 * rather than here.
 */
export function assign(row: PlaceRow): PlaceAssignment {
  const arm = armFor(row.category);
  const locality = (row.locality ?? '').trim();
  const postcode = (row.postcode ?? '').trim();
  const raw = [postcode, locality].filter((part) => part.length > 0).join(' ');
  const phone = (row.phones ?? [])[0];
  const match = resolveCity(raw, phone === undefined ? undefined : { phone });
  if (match === null) return { municipalityId: UNASSIGNED, cityId: null, arm };
  return { municipalityId: match.municipalityId, cityId: match.cityId, arm };
}

/** `mun:novi-sad|arm:store-category` — one discovery scope. */
export function scopeKey(municipalityId: string, arm: QueryArm): string {
  return `mun:${municipalityId}|arm:${arm}`;
}

/** What one scope produced, written to `crawl_state.cursor` as JSON. */
export interface ScopeYield {
  readonly municipalityId: string;
  readonly arm: QueryArm;
  /** Where discovery got to inside this scope, so an interrupted run resumes mid-scope. */
  readonly offset: number;
  readonly records: number;
  readonly withPhone: number;
  readonly withWebsite: number;
  readonly withEmail: number;
  /** Website but no phone — the enrichment crawler's worklist. */
  readonly enrichmentTargets: number;
  /** Belgrade is 17 city municipalities under one unit; this is where they stay visible. */
  readonly byCity: Readonly<Record<string, number>>;
}

export interface PlanEntry {
  readonly scopeKey: string;
  readonly municipalityId: string;
  readonly arm: QueryArm;
  readonly rows: readonly AssignedRow[];
}

export interface AssignedRow {
  readonly row: PlaceRow;
  readonly assignment: PlaceAssignment;
}

/**
 * The same rule `place.ts` applies when it builds the record: a list holding
 * nothing but empty strings is an empty list. Six rows in the national extract
 * carry `phones: [""]`, and counting those as phone numbers here would report a
 * yield the emitted records do not have.
 */
const has = (value: readonly string[] | null | undefined): boolean =>
  (value ?? []).some((entry) => entry.trim().length > 0);

export function yieldOf(entry: PlanEntry, offset: number): ScopeYield {
  const byCity: Record<string, number> = {};
  let withPhone = 0;
  let withWebsite = 0;
  let withEmail = 0;
  let enrichmentTargets = 0;

  for (const { row, assignment } of entry.rows) {
    const phone = has(row.phones);
    const website = has(row.websites);
    if (phone) withPhone += 1;
    if (website) withWebsite += 1;
    if (has(row.emails)) withEmail += 1;
    if (website && !phone) enrichmentTargets += 1;
    const city = assignment.cityId ?? UNASSIGNED;
    byCity[city] = (byCity[city] ?? 0) + 1;
  }

  return {
    municipalityId: entry.municipalityId,
    arm: entry.arm,
    offset,
    records: entry.rows.length,
    withPhone,
    withWebsite,
    withEmail,
    enrichmentTargets,
    byCity,
  };
}

/**
 * Every municipality × arm scope, in crawl order, with its rows attached.
 *
 * Empty scopes are kept. A unit that yielded nothing is the finding — dropping
 * it would turn "145 units walked, 25 empty" into "120 units walked", which is
 * the same data set answering a materially weaker question.
 */
export function planScopes(
  rows: readonly PlaceRow[],
  restrictTo: readonly Municipality[] = [],
): readonly PlanEntry[] {
  const requested = new Set(restrictTo.map((unit) => unit.id));
  const assigned: AssignedRow[] = rows.map((row) => ({ row, assignment: assign(row) }));

  const inScope = (entry: AssignedRow): boolean => {
    if (requested.size === 0) return true;
    const { municipalityId, cityId } = entry.assignment;
    return requested.has(municipalityId) || (cityId !== null && requested.has(cityId));
  };

  const buckets = new Map<string, AssignedRow[]>();
  for (const entry of assigned) {
    if (!inScope(entry)) continue;
    const key = scopeKey(entry.assignment.municipalityId, entry.assignment.arm);
    const slot = buckets.get(key);
    if (slot === undefined) buckets.set(key, [entry]);
    else slot.push(entry);
  }

  const units =
    requested.size === 0
      ? coverageUnits.map((unit) => unit.id)
      : coverageUnits
          .filter(
            (unit) =>
              requested.has(unit.id) || [...requested].some((id) => id.startsWith(`${unit.id}-`)),
          )
          .map((unit) => unit.id);

  const plan: PlanEntry[] = [];
  for (const municipalityId of [...units, UNASSIGNED]) {
    for (const arm of QUERY_ARMS) {
      const key = scopeKey(municipalityId, arm);
      plan.push({ scopeKey: key, municipalityId, arm, rows: buckets.get(key) ?? [] });
    }
  }
  return plan;
}

/** The national picture, for the run log and the README's numbers. */
export interface CoverageSummary {
  readonly records: number;
  readonly withPhone: number;
  readonly withWebsite: number;
  readonly withEmail: number;
  readonly enrichmentTargets: number;
  readonly unitsCovered: number;
  readonly unitsTotal: number;
  readonly unassigned: number;
}

export function summarize(plan: readonly PlanEntry[]): CoverageSummary {
  let records = 0;
  let withPhone = 0;
  let withWebsite = 0;
  let withEmail = 0;
  let enrichmentTargets = 0;
  let unassigned = 0;
  const covered = new Set<string>();

  for (const entry of plan) {
    const stats = yieldOf(entry, 0);
    records += stats.records;
    withPhone += stats.withPhone;
    withWebsite += stats.withWebsite;
    withEmail += stats.withEmail;
    enrichmentTargets += stats.enrichmentTargets;
    if (entry.municipalityId === UNASSIGNED) unassigned += stats.records;
    else if (stats.records > 0) covered.add(entry.municipalityId);
  }

  return {
    records,
    withPhone,
    withWebsite,
    withEmail,
    enrichmentTargets,
    unitsCovered: covered.size,
    unitsTotal: coverageUnits.length,
    unassigned,
  };
}

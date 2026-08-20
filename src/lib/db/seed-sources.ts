/**
 * The Stage 1 source registries, as `sources` rows.
 *
 * `research/sources-contractors.json` and `research/sources-stores.json` are the
 * evidence base every adapter is built from, and they are reviewed like code.
 * This turns them into database rows so a `source_id` on a lead, a phone or a
 * raw record resolves to something the database can describe on its own.
 *
 * The two registries were written by different research passes and do not agree
 * on every convention — `robots_allows` is a verdict sentence in one and a
 * boolean in the other, categories are prose in one and slugs in the other — so
 * the mapping below is deliberately tolerant and normalizes rather than
 * assuming. Three sources appear in both registries (`apr-registry`,
 * `kupujemprodajem`, `stovarista-rs`); they become one row whose
 * `has_contractors` / `has_stores` flags are the union of both entries.
 *
 * Seeding is idempotent: re-running after a registry edit refreshes the rows
 * and leaves `created_at` alone.
 */
import contractorRegistry from '../../../research/sources-contractors.json' with { type: 'json' };
import storeRegistry from '../../../research/sources-stores.json' with { type: 'json' };
import type { Db } from './client.js';
import { upsertSource, type Executor } from './repo.js';
import type { NewSource, SourcePriority } from './schema.js';

/** The subset of a registry entry this schema stores. Everything else stays in the JSON. */
interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly category: string;
  readonly has_contractors?: boolean;
  readonly has_stores?: boolean;
  readonly estimated_records?: number | null;
  readonly requires_js?: boolean;
  readonly robots_allows?: boolean | string | null;
  readonly robots_rule?: string | null;
  readonly priority?: string;
  readonly notes?: string | null;
}

interface Registry {
  readonly sources: readonly RegistryEntry[];
  readonly summary?: { readonly rejected_ids?: readonly string[] } | undefined;
}

const REGISTRIES: ReadonlyArray<{ file: string; registry: Registry }> = [
  {
    file: 'research/sources-contractors.json',
    registry: contractorRegistry as unknown as Registry,
  },
  { file: 'research/sources-stores.json', registry: storeRegistry as unknown as Registry },
];

/**
 * `High` / `Medium` / `Low` from the registries, plus `rejected` for the ids the
 * research explicitly ruled out. An unrecognised value is treated as `low`
 * rather than guessed at.
 */
function toPriority(value: string | undefined, rejected: boolean): SourcePriority {
  if (rejected) return 'rejected';
  switch ((value ?? '').trim().toLowerCase()) {
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * The contractor registry states the robots verdict as a sentence beginning
 * `ALLOWED …` or `DISALLOWED …`; the store registry uses a boolean, sometimes
 * null. `null` means "the research could not tell" and must stay `null` — a
 * crawler treating unknown as allowed is exactly the compliance failure the
 * project cannot have.
 */
export function parseRobotsVerdict(value: boolean | string | null | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  if (text.startsWith('ALLOWED')) return true;
  if (text.startsWith('DISALLOWED') || text.startsWith('BLOCKED') || text.startsWith('NOT ALLOWED'))
    return false;
  // "NO robots.txt PUBLISHED …" — nothing forbids the crawl, but nothing
  // permits it in writing either. Unknown, not allowed.
  return null;
}

/** The verbatim rule the verdict came from, wherever the registry put it. */
function robotsRuleOf(entry: RegistryEntry): string | null {
  if (typeof entry.robots_rule === 'string' && entry.robots_rule !== '') return entry.robots_rule;
  if (typeof entry.robots_allows === 'string') return entry.robots_allows;
  return null;
}

type SeedRow = Omit<NewSource, 'createdAt' | 'updatedAt'> & { registryFiles: string };

/**
 * The rows the registries describe, merged across both files.
 *
 * Pure — it reads the committed JSON and returns rows. Exported so a test can
 * check the mapping without a database, and so a report can list what would be
 * seeded before anything is written.
 */
export function registrySourceRows(): SeedRow[] {
  const rows = new Map<string, SeedRow>();

  for (const { file, registry } of REGISTRIES) {
    const rejectedIds = new Set(registry.summary?.rejected_ids ?? []);
    for (const entry of registry.sources) {
      const priority = toPriority(entry.priority, rejectedIds.has(entry.id));
      const row: SeedRow = {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        category: entry.category,
        priority,
        hasContractors: entry.has_contractors === true,
        hasStores: entry.has_stores === true,
        requiresJs: entry.requires_js === true,
        robotsAllows: parseRobotsVerdict(entry.robots_allows),
        robotsRule: robotsRuleOf(entry),
        estimatedRecords: entry.estimated_records ?? null,
        registryFiles: file,
        // A rejected source stays on record, disabled: knowing it was evaluated
        // and dropped is worth as much as knowing it was kept.
        enabled: priority !== 'rejected',
        notes: entry.notes ?? null,
      };

      const existing = rows.get(entry.id);
      rows.set(entry.id, existing ? mergeRows(existing, row) : row);
    }
  }

  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const PRIORITY_RANK: Record<SourcePriority, number> = { high: 0, medium: 1, low: 2, rejected: 3 };

/** A source in both registries serves both segments; the stronger verdict wins. */
function mergeRows(a: SeedRow, b: SeedRow): SeedRow {
  const priority =
    PRIORITY_RANK[a.priority ?? 'low'] <= PRIORITY_RANK[b.priority ?? 'low']
      ? (a.priority ?? 'low')
      : (b.priority ?? 'low');
  return {
    ...a,
    priority,
    hasContractors: a.hasContractors === true || b.hasContractors === true,
    hasStores: a.hasStores === true || b.hasStores === true,
    requiresJs: a.requiresJs === true || b.requiresJs === true,
    robotsAllows: a.robotsAllows ?? b.robotsAllows,
    robotsRule: a.robotsRule ?? b.robotsRule,
    estimatedRecords: Math.max(a.estimatedRecords ?? 0, b.estimatedRecords ?? 0) || null,
    registryFiles: [a.registryFiles, b.registryFiles].join(','),
    enabled: priority !== 'rejected',
    notes: a.notes ?? b.notes,
  };
}

/** Write the registries into `sources`. Returns how many rows were seeded. */
export function seedSources(db: Db | Executor, seededAt: Date = new Date()): number {
  const rows = registrySourceRows();
  for (const row of rows) {
    upsertSource(db, { ...row, updatedAt: seededAt });
  }
  return rows.length;
}

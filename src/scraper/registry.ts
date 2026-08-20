/**
 * The adapter registry.
 *
 * "Adding a new source must never require editing shared code beyond
 * registering the adapter" is the requirement, and the cheapest way to honour
 * it is to make registering the adapter mean *existing*: every directory under
 * `src/scraper/sources/` whose `index.ts` default-exports a `SourceAdapter` is
 * a source. There is no list to append to, so there is no list to forget.
 *
 * `registerAdapters` is the explicit path, for tests and for a caller that
 * wants a fixed set without touching the filesystem.
 */
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ScraperError } from './errors.js';
import type { SourceAdapter } from './types.js';

/** `src/scraper/sources`, resolved from this file so the CLI and vitest agree. */
export const SOURCES_DIR = new URL('./sources/', import.meta.url);

/** Not a source: a shared helper directory, a fixture stash, an editor artefact. */
function isSourceDirectory(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('_') && name !== 'node_modules';
}

/** Enough of a shape check that a typo fails at load rather than mid-crawl. */
export function assertAdapter(value: unknown, origin: string): SourceAdapter {
  const adapter = value as Partial<SourceAdapter> | undefined;
  const problems: string[] = [];
  if (adapter === undefined || adapter === null) problems.push('no default export');
  else {
    if (typeof adapter.id !== 'string' || adapter.id === '') problems.push('missing `id`');
    if (typeof adapter.name !== 'string' || adapter.name === '') problems.push('missing `name`');
    if (typeof adapter.baseUrl !== 'string' || adapter.baseUrl === '')
      problems.push('missing `baseUrl`');
    if (!Array.isArray(adapter.leadTypes)) problems.push('missing `leadTypes`');
    if (typeof adapter.discover !== 'function') problems.push('missing `discover`');
    if (typeof adapter.extract !== 'function') problems.push('missing `extract`');
  }
  if (problems.length > 0) {
    throw new ScraperError(`${origin} is not a SourceAdapter: ${problems.join(', ')}`);
  }
  return adapter as SourceAdapter;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  add(adapter: SourceAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new ScraperError(`two adapters claim the source id \`${adapter.id}\``);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): SourceAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Throws with the list of known ids — a typo in `--source` should say what was meant. */
  require(id: string): SourceAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new ScraperError(
        `unknown source \`${id}\`. Registered: ${this.ids().join(', ') || '(none)'}`,
      );
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  all(): SourceAdapter[] {
    return this.ids().map((id) => this.adapters.get(id) as SourceAdapter);
  }
}

/** Build a registry from adapters the caller already holds. */
export function registerAdapters(adapters: readonly SourceAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) registry.add(adapter);
  return registry;
}

/**
 * Discover every adapter on disk.
 *
 * `index.ts` under tsx and vitest, `index.js` once something compiles it —
 * both are tried, and a directory with neither is skipped rather than fatal, so
 * a half-written source in a working tree does not break `--list-sources`.
 */
export async function loadAdapters(dir: URL = SOURCES_DIR): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !isSourceDirectory(entry.name)) continue;

    let loaded: unknown;
    for (const file of ['index.ts', 'index.js']) {
      const candidate = new URL(`${entry.name}/${file}`, dir);
      try {
        loaded = ((await import(pathToFileURL(candidate.pathname).href)) as { default: unknown })
          .default;
        break;
      } catch (error) {
        // A missing file is "this directory is not a source yet"; anything else
        // is a broken adapter and must not be swallowed.
        if ((error as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      }
    }
    if (loaded === undefined) continue;
    registry.add(assertAdapter(loaded, `src/scraper/sources/${entry.name}`));
  }

  return registry;
}

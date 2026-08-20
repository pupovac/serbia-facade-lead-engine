/**
 * The registry.
 *
 * The requirement it defends: adding a source means writing one directory. So
 * what is asserted is that a directory on disk is enough, and that a broken one
 * fails at load rather than silently mid-crawl.
 */
import { describe, expect, it } from 'vitest';
import { ScraperError } from './errors.js';
import { AdapterRegistry, assertAdapter, loadAdapters, registerAdapters } from './registry.js';
import type { SourceAdapter } from './types.js';

const STUB: SourceAdapter = {
  id: 'primer',
  name: 'Primer direktorijum',
  baseUrl: 'https://primer.rs',
  leadTypes: ['FACADE_CONTRACTOR'],
  async *discover() {},
  async extract() {
    return [];
  },
};

describe('loadAdapters', () => {
  it('finds the adapters on disk with no list to maintain', async () => {
    const registry = await loadAdapters();

    expect(registry.ids()).toContain('example');
    const example = registry.require('example');
    expect(example.leadTypes).toContain('FACADE_CONTRACTOR');
  });
});

describe('AdapterRegistry', () => {
  it('refuses two adapters claiming one source id', () => {
    const registry = new AdapterRegistry().add(STUB);

    expect(() => registry.add({ ...STUB })).toThrow(/two adapters claim/);
  });

  it('names the registered ids when asked for one that does not exist', () => {
    const registry = registerAdapters([STUB]);

    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(/Registered: primer/);
  });

  it('lists adapters in a stable order', () => {
    const registry = registerAdapters([{ ...STUB, id: 'zzz' }, STUB, { ...STUB, id: 'aaa' }]);

    expect(registry.ids()).toEqual(['aaa', 'primer', 'zzz']);
    expect(registry.all().map((adapter) => adapter.id)).toEqual(['aaa', 'primer', 'zzz']);
  });
});

describe('assertAdapter', () => {
  it('accepts a complete adapter', () => {
    expect(assertAdapter(STUB, 'stub')).toBe(STUB);
  });

  it('says what is missing rather than failing mid-crawl', () => {
    expect(() => assertAdapter(undefined, 'sources/typo')).toThrow(ScraperError);
    expect(() => assertAdapter({ id: 'x' }, 'sources/typo')).toThrow(
      /missing `name`.*missing `baseUrl`.*missing `leadTypes`.*missing `discover`/,
    );
  });
});

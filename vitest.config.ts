import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      // The scraper is included for visibility, not for a gate: only the phone
      // module carries a threshold. Fixture servers and the CLI entry point are
      // marked with `c8 ignore` where they are genuinely not worth covering.
      include: ['src/lib/**/*.ts', 'src/scraper/**/*.ts'],
      // The phone module decides what a phone number is, and it is both the
      // deliverable and the strongest dedup key. Every branch of it — every
      // rejection reason, every confidence step, every place a page can hide a
      // number — is reachable from the test tables, and this is what keeps it
      // that way.
      //
      // The text reporter only prints a file that is below 100% on some metric,
      // so `src/lib/phone` having no rows in the coverage table is what passing
      // looks like — not a threshold that matches nothing. Starve the phone
      // tests, or leave one branch uncovered, and this block exits 1.
      thresholds: {
        'src/lib/phone/**/*.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@/lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      '@/scraper': fileURLToPath(new URL('./src/scraper', import.meta.url)),
      '@/app': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
});

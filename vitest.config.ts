import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@/lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      '@/scraper': fileURLToPath(new URL('./src/scraper', import.meta.url)),
      '@/app': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
});

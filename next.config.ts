import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundler and let
  // Node require it at runtime from the server side of the App Router.
  serverExternalPackages: ['better-sqlite3'],

  // Don't let `next dev` drop generated AGENTS.md / CLAUDE.md into the repo
  // root — the conventions live in CONTRIBUTING.md and docs/architecture.md.
  agentRules: false,

  experimental: {
    /**
     * `src/lib` is written in the NodeNext ESM style: every relative import
     * carries the `.js` extension it will have at runtime (`./schema.js`
     * resolving to `schema.ts`). `tsc`, `tsx` and vitest all handle that;
     * a bundler needs to be told, and this is the mapping that tells webpack.
     *
     * Turbopack cannot do this — Next lists `experimental.extensionAlias`
     * among the options it does not support — which is why `dev` and `build`
     * pass `--webpack`. Drop both the flag and this block on the day `src/lib`
     * stops writing `.js` specifiers.
     */
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    },
  },

  /**
   * `src/lib/db/client.ts` computes the migrations directory with
   * `new URL('../../../drizzle', import.meta.url)`. webpack treats that as an
   * asset reference and tries to resolve a directory that is not a module, so
   * `new URL` asset handling is switched off; `app/lib/db.ts` runs the migrator
   * against the project root instead.
   */
  webpack: (config) => {
    config.module.parser = {
      ...config.module.parser,
      javascript: { ...config.module.parser?.javascript, url: false },
    };
    return config;
  },
};

export default nextConfig;

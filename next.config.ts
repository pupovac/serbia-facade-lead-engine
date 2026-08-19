import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundler and let
  // Node require it at runtime from the server side of the App Router.
  serverExternalPackages: ['better-sqlite3'],

  // Don't let `next dev` drop generated AGENTS.md / CLAUDE.md into the repo
  // root — the conventions live in CONTRIBUTING.md and docs/architecture.md.
  agentRules: false,
};

export default nextConfig;

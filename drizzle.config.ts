/**
 * drizzle-kit configuration.
 *
 * `npm run db:generate` writes a new migration into `drizzle/` from
 * `src/lib/db/schema.ts`; `npm run db:migrate` applies the pending ones to
 * `DATABASE_PATH`. The database file is never edited by hand.
 */
import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/leads.sqlite',
  },
  strict: true,
  verbose: true,
} satisfies Config;

/**
 * End-to-end check of the review UI's write path, driven through the browser.
 *
 * The unit tests in `src/lib/review/decisions.test.ts` assert the rules. This
 * asserts the wiring: that a reviewer clicking the buttons in a running server
 * actually reaches those rules, and that the most important guarantee — a human
 * edit surviving a later crawl — holds against the real pilot database rather
 * than an in-memory fixture.
 *
 *   cp data/leads.sqlite data/leads-e2e.sqlite
 *   DATABASE_PATH=./data/leads-e2e.sqlite npx next start -p 3112 &
 *   npx tsx scripts/fuzz25-e2e.ts http://localhost:3112 ./data/leads-e2e.sqlite
 */
import { chromium, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { closeDatabase, openDatabase, type Db } from '../src/lib/db/index.js';
import { getLead, upsertLead } from '../src/lib/db/repo.js';
import {
  leadFieldValues,
  leads,
  mergeCandidates,
  enrichmentSuggestions,
} from '../src/lib/db/schema.js';
import {
  listLeads,
  mergeQueue,
  suggestionQueue,
  REVIEWER_SOURCE_ID,
} from '../src/lib/review/index.js';

const BASE = process.argv[2] ?? 'http://localhost:3112';
const DB_PATH = process.argv[3] ?? './data/leads-e2e.sqlite';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`,
  );
}

function read<T>(fn: (db: Db) => T): T {
  const db = openDatabase({ url: DB_PATH, migrate: false, readonly: true });
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

function write<T>(fn: (db: Db) => T): T {
  const db = openDatabase({ url: DB_PATH, migrate: false });
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

async function submit(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await Promise.all([page.waitForLoadState('networkidle'), locator.click()]);
  await page.waitForTimeout(300);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

/* -- 1. a human edit, made in the UI ------------------------------------- */

const target = read((db) => listLeads(db, { pageSize: 1, hasPhone: true, sort: 'score' }).rows[0]);
if (!target) throw new Error('no leads in the database');
const before = read((db) => getLead(db, target.id));
const NEW_ADDRESS = 'Bulevar oslobođenja 100a';
console.log(
  `\nlead #${target.id} ${target.name} — address before: ${before?.address ?? '(none)'}\n`,
);

await page.goto(`${BASE}/leads/${target.id}`, { waitUntil: 'networkidle' });
const addressInput = page.locator(`#address-${target.id}`);
await addressInput.fill(NEW_ADDRESS);
await submit(page, addressInput.locator('xpath=../..').getByRole('button', { name: 'Sačuvaj' }));

check(
  'UI edit reached the database',
  read((db) => getLead(db, target.id)?.address),
  NEW_ADDRESS,
);
check(
  'the edit carries manual-review provenance and is current',
  read((db) =>
    db
      .select({ src: leadFieldValues.sourceId, cur: leadFieldValues.isCurrent })
      .from(leadFieldValues)
      .where(eq(leadFieldValues.leadId, target.id))
      .all()
      .filter((row) => row.cur)
      .some((row) => row.src === REVIEWER_SOURCE_ID),
  ),
  true,
);

/* -- 2. the crawl comes back with the old value -------------------------- */

write((db) =>
  upsertLead(
    db,
    {
      leadId: target.id,
      name: target.name,
      nameNormalized: before?.nameNormalized ?? target.name.toLowerCase(),
      address: before?.address ?? 'Neka stara adresa 1',
      cityRaw: before?.cityRaw ?? null,
    },
    {
      sourceId: 'gradjevinarstvo-rs',
      sourceUrl: 'https://www.gradjevinarstvo.rs/firme/1/recrawl',
      seenAt: new Date('2026-09-01'),
    },
    { matching: 'caller' },
  ),
);
check(
  'the human edit survived a subsequent crawl',
  read((db) => getLead(db, target.id)?.address),
  NEW_ADDRESS,
);
check(
  'the crawl’s value was kept as a conflict, not discarded',
  read((db) =>
    db
      .select({ value: leadFieldValues.value })
      .from(leadFieldValues)
      .where(eq(leadFieldValues.leadId, target.id))
      .all()
      .some((row) => row.value === (before?.address ?? 'Neka stara adresa 1')),
  ),
  true,
);

/* -- 3. a review decision ------------------------------------------------ */

await page.goto(`${BASE}/leads/${target.id}`, { waitUntil: 'networkidle' });
await page.locator(`#note-${target.id}`).fill('pozvan 21.08, traži uzorak');
await submit(page, page.getByRole('button', { name: 'Odobri' }));
const decided = read((db) => db.select().from(leads).where(eq(leads.id, target.id)).get());
check('status recorded from the UI', decided?.status, 'approved');
check('note recorded', decided?.reviewNote?.includes('pozvan 21.08, traži uzorak'), true);

/* -- 4. rejecting a merge pair sticks ------------------------------------ */

const pairBefore = read((db) => mergeQueue(db, 1, 1));
const candidateId = pairBefore.pairs[0]?.candidate.id;
if (candidateId == null) throw new Error('no pending merge candidates');
await page.goto(`${BASE}/merges`, { waitUntil: 'networkidle' });
await submit(page, page.getByRole('button', { name: 'Nisu isti' }).first());
check(
  'rejected pair is resolved',
  read(
    (db) =>
      db.select().from(mergeCandidates).where(eq(mergeCandidates.id, candidateId)).get()?.status,
  ),
  'rejected',
);
check(
  'the queue shrank by one',
  read((db) => mergeQueue(db, 1, 1).total),
  pairBefore.total - 1,
);

/* -- 5. merging a pair is transactional and reversible ------------------- */

const pair = read((db) => mergeQueue(db, 1, 1).pairs[0]);
if (!pair) throw new Error('no pending merge candidates left');
const survivor = pair.a.lead.id;
const absorbed = pair.b.lead.id;
await page.goto(`${BASE}/merges`, { waitUntil: 'networkidle' });
await submit(page, page.getByRole('button', { name: `Spoji — zadrži A (#${survivor})` }).first());
check(
  'the absorbed lead points at the survivor',
  read((db) => getLead(db, absorbed)?.mergedIntoId),
  survivor,
);

await page.goto(`${BASE}/leads/${survivor}`, { waitUntil: 'networkidle' });
await submit(page, page.getByRole('button', { name: 'Poništi spajanje' }).first());
check(
  'the merge was undone',
  read((db) => getLead(db, absorbed)?.mergedIntoId),
  null,
);
check(
  'and the pair is back in the queue',
  read(
    (db) =>
      db.select().from(mergeCandidates).where(eq(mergeCandidates.id, pair.candidate.id)).get()
        ?.status,
  ),
  'pending',
);

/* -- 6. enrichment suggestions ------------------------------------------- */

const suggestion = read((db) => suggestionQueue(db, 1, 1).items[0]);
if (suggestion) {
  await page.goto(`${BASE}/suggestions`, { waitUntil: 'networkidle' });
  await submit(page, page.getByRole('button', { name: 'Prihvati' }).first());
  check(
    'accepted suggestion is resolved by the reviewer',
    read((db) =>
      db
        .select({ status: enrichmentSuggestions.status, by: enrichmentSuggestions.resolvedBy })
        .from(enrichmentSuggestions)
        .where(eq(enrichmentSuggestions.id, suggestion.suggestion.id))
        .get(),
    ),
    { status: 'accepted', by: 'reviewer:owner' },
  );

  await page.goto(`${BASE}/suggestions`, { waitUntil: 'networkidle' });
  await submit(page, page.getByRole('button', { name: 'Odbij' }).first());
  check(
    'rejections are remembered',
    read(
      (db) =>
        db
          .select()
          .from(enrichmentSuggestions)
          .where(eq(enrichmentSuggestions.status, 'rejected'))
          .all().length,
    ),
    1,
  );
}

await browser.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

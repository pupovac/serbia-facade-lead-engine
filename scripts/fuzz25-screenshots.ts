/**
 * Capture the five review-UI views against whatever database the server is
 * serving, so the owner can see the leads without running anything.
 *
 *   npm run build && npx next start -p 3111 &
 *   npx tsx scripts/fuzz25-screenshots.ts http://localhost:3111 ./screenshots
 *
 * The lead the detail shot uses is chosen from the data — the active lead with
 * the most distinct numbers across the most sources — rather than hard-coded,
 * so the shot stays representative when the corpus changes.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { closeDatabase, openDatabase } from '../src/lib/db/index.js';
import { listLeads, mergeQueue } from '../src/lib/review/index.js';

const BASE = process.argv[2] ?? 'http://localhost:3111';
const OUT = process.argv[3] ?? './screenshots';
const DB = process.env.DATABASE_PATH ?? './data/leads.sqlite';

function pickRichestLead(): number {
  const db = openDatabase({ url: DB, migrate: false, readonly: true });
  try {
    // Best score among leads carrying several numbers: the detail page is only
    // worth looking at when there is provenance to show.
    const candidates = listLeads(db, { pageSize: 60, hasPhone: true, sort: 'score' }).rows;
    const richest = [...candidates].sort(
      (a, b) => b.sourceCount - a.sourceCount || b.phoneCount - a.phoneCount,
    )[0];
    return richest?.id ?? candidates[0]?.id ?? 1;
  } finally {
    closeDatabase(db);
  }
}

function busiestMunicipality(): string {
  const db = openDatabase({ url: DB, migrate: false, readonly: true });
  try {
    return mergeQueue(db, 1, 1).pairs[0]?.a.lead.municipalityId ?? 'beograd';
  } finally {
    closeDatabase(db);
  }
}

const leadId = pickRichestLead();
const municipality = busiestMunicipality();

/**
 * `height` caps a shot that would otherwise be unreadable once scaled down.
 * The merge queue is five side-by-side cards to a page; the point of the shot
 * is that a reviewer can read one pair, not that there are five of them.
 */
const SHOTS: ReadonlyArray<{ file: string; path: string; note: string; height?: number }> = [
  { file: '1-dashboard.png', path: '/', note: 'Dashboard' },
  {
    file: '2-lead-list-filtered.png',
    path: `/leads?opstina=${municipality}&phone=yes&type=CONSTRUCTION_MATERIAL_STORE&sort=score`,
    note: 'Lead list, filter applied',
  },
  { file: '3-lead-detail.png', path: `/leads/${leadId}`, note: 'Lead detail' },
  { file: '4-merge-queue.png', path: '/merges', note: 'Merge review queue', height: 1750 },
  { file: '5-enrichment-suggestions.png', path: '/suggestions', note: 'Enrichment suggestions' },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1680, height: 1050 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});

/**
 * A full-page screenshot paints `position: sticky` elements where they sit in
 * the viewport, so the table header lands on top of the first row. That is an
 * artefact of the capture, not of the UI, and it is exactly the row a reader
 * looks at first — so sticky is switched off for the shot only.
 */
const UNSTICK = 'header.topbar, thead th { position: static !important; }';

for (const shot of SHOTS) {
  const response = await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
  const status = response?.status() ?? 0;
  if (status !== 200) throw new Error(`${shot.path} returned ${status}`);
  await page.addStyleTag({ content: UNSTICK });
  await page.screenshot({
    path: `${OUT}/${shot.file}`,
    ...(shot.height == null
      ? { fullPage: true }
      : { clip: { x: 0, y: 0, width: 1680, height: shot.height } }),
  });
  console.log(`${shot.file.padEnd(32)} ${status}  ${shot.path}`);
}

await browser.close();
console.log(`\nwrote ${SHOTS.length} screenshots to ${OUT}`);

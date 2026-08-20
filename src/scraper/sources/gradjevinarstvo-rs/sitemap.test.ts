/**
 * `gradjevinarstvo-rs` — the sitemap is the enumeration, so it is tested like
 * one: what it yields, in what order, and what it refuses to yield.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFirmSitemap } from './sitemap.js';

const BASE = 'https://www.gradjevinarstvo.rs';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

describe('parseFirmSitemap', () => {
  it('reads every company URL in the real document', () => {
    const { firms, skipped } = parseFirmSitemap(fixture('firme-sitemap.xml'), BASE);
    expect(firms).toHaveLength(10);
    expect(skipped).toBe(0);
    expect(firms[0]).toEqual({
      id: 1003,
      slug: 'alba',
      url: `${BASE}/firme/1003/alba`,
    });
  });

  it('orders by company id, because the resume cursor is a company id', () => {
    const { firms } = parseFirmSitemap(
      `<urlset>
         <url><loc>${BASE}/firme/900/zzz</loc></url>
         <url><loc>${BASE}/firme/12/aaa</loc></url>
         <url><loc>${BASE}/firme/57/mmm</loc></url>
       </urlset>`,
      BASE,
    );
    expect(firms.map((firm) => firm.id)).toEqual([12, 57, 900]);
  });

  it('counts what it dropped instead of quietly shrinking', () => {
    const { firms, skipped } = parseFirmSitemap(
      `<urlset>
         <url><loc>${BASE}/firme/1003/alba</loc></url>
         <url><loc>${BASE}/tekstovi/neki-clanak</loc></url>
         <url><loc>${BASE}/kategorije/143/izolacija</loc></url>
       </urlset>`,
      BASE,
    );
    expect(firms.map((firm) => firm.id)).toEqual([1003]);
    expect(skipped).toBe(2);
  });

  it('keeps one entry per company when the sitemap lists it twice', () => {
    const { firms } = parseFirmSitemap(
      `<urlset>
         <url><loc>${BASE}/firme/1003/alba</loc></url>
         <url><loc>${BASE}/firme/1003/alba-doo</loc></url>
       </urlset>`,
      BASE,
    );
    expect(firms).toHaveLength(1);
    expect(firms[0]?.slug).toBe('alba');
  });

  it('returns nothing for a document with no entries, so the caller can raise', () => {
    // `discover` runs this through `ctx.expect`. An empty sitemap is a source
    // that changed, not a register that emptied overnight.
    expect(parseFirmSitemap(fixture('firme-sitemap-empty.xml'), BASE).firms).toHaveLength(0);
  });
});

/**
 * Extraction against a real Serbian directory page, saved verbatim.
 *
 * The numbers on that page were counted by hand before these expectations were
 * written: 101 distinct runs of digits are visible to a reader, 97 of them are
 * phone numbers, and the four that are not are a founding date, a price, an
 * opening-hours range and a copyright year span. See `__fixtures__/README.md`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { acceptedPhones, extractPhones, rejectedPhones } from './extract.js';

const html = readFileSync(
  fileURLToPath(new URL('./__fixtures__/portal-srbija-termo-izolacija.html', import.meta.url)),
  'utf8',
);

const found = extractPhones(html, { html: true });
const accepted = acceptedPhones(found);
const e164s = new Set(accepted.map((entry) => entry.phone?.e164));

/** The same page with every tag thrown away — what a reader is left looking at. */
function visibleText(): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, head').remove();
  return $.root().text().replace(/\s+/g, ' ');
}

describe('a real listing page', () => {
  it('finds all 97 distinct numbers the page publishes', () => {
    expect(accepted).toHaveLength(97);
    expect(e164s.size).toBe(97);
  });

  it('agrees with the page markup — 100 tel: links, 97 distinct', () => {
    const $ = cheerio.load(html);
    const hrefs = $('a[href^="tel:"]')
      .map((_, element) => $(element).attr('href')?.slice(4) ?? '')
      .toArray();
    expect(hrefs).toHaveLength(100);
    expect(new Set(hrefs).size).toBe(97);
  });

  it('finds the same 97 with the markup stripped away, not just from tel: links', () => {
    const fromText = new Set(
      acceptedPhones(extractPhones(visibleText())).map((entry) => entry.phone?.e164),
    );
    expect(fromText).toEqual(e164s);
  });

  it('leaves nothing on the page it had to reject', () => {
    expect(rejectedPhones(found)).toEqual([]);
  });

  it('accounts for every visible run of digits: 97 phones, 4 that are not', () => {
    const runs = [
      ...new Set((visibleText().match(/[+\d][\d ()+./-]{5,}\d/g) ?? []).map((r) => r.trim())),
    ];
    const notPhones = runs.filter((run) => extractPhones(run).length === 0);
    expect(runs).toHaveLength(101);
    // A founding date, a price, opening hours and a copyright span.
    expect(notPhones).toEqual(['17.03.2004', '150 000', '08 - 20', '2006-2026']);
  });

  it('splits them the way a directory of Belgrade tradesmen should split', () => {
    const types = accepted.map((entry) => entry.phone?.type);
    expect(types.filter((t) => t === 'landline')).toHaveLength(80);
    expect(types.filter((t) => t === 'mobile')).toHaveLength(17);
  });

  it('recovers a city for every landline, from the area code alone', () => {
    const landlines = accepted.filter((entry) => entry.phone?.type === 'landline');
    expect(landlines.every((entry) => entry.phone?.inferredCityId !== undefined)).toBe(true);
    const cities = new Set(landlines.map((entry) => entry.phone?.inferredCityId));
    expect(cities.size).toBe(14);
    expect(cities).toContain('beograd');
    expect(cities).toContain('novi-sad');
    expect(cities).toContain('cacak');
  });

  it('canonicalizes the raw href form the page actually published', () => {
    const first = accepted.find((entry) => entry.phone?.e164 === '+381112176253');
    expect(first?.raw).toBe('0112176253');
    expect(first?.origin).toBe('tel-link');
    expect(first?.phone?.nationalFormat).toBe('011 2176253');
  });
});

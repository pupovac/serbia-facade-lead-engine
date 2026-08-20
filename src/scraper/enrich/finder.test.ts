/**
 * The search provider, and the thing it does when it is not allowed to search.
 *
 * `duckduckgo-challenge.html` is real: it is what `html.duckduckgo.com`
 * returned on 2026-08-20 to an ordinary query from this runtime, with the
 * project's honest User-Agent and a `robots.txt` that says `Allow: /`. The test
 * that matters here is that the provider recognises it and gives up, because
 * the alternative — pretending to be a browser until the challenge stops — is
 * out of bounds and the alternative to that — returning zero results — would
 * report a business with no pages when what happened is that nobody asked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { leadRecord } from '@/lib/dedup';
import {
  buildQuery,
  DuckDuckGoHtmlFinder,
  isChallenge,
  parseDuckDuckGoResults,
  SearchChallengedError,
} from './finder.js';
import type { EnrichmentTarget } from './types.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const TARGET: EnrichmentTarget = {
  leadId: 1,
  name: 'Mika Fasade',
  cityName: 'Novi Sad',
  record: leadRecord({ id: 1, name: 'Mika Fasade', cityId: 'novi-sad' }),
  websites: [],
  missing: ['phone', 'email'],
  potentialGain: 48,
};

describe('buildQuery', () => {
  it('quotes the name, adds the city and biases toward the contact page', () => {
    expect(buildQuery(TARGET)).toBe('"Mika Fasade" Novi Sad kontakt');
  });

  it('omits a city it has not got', () => {
    expect(buildQuery({ ...TARGET, cityName: null })).toBe('"Mika Fasade" kontakt');
  });

  it('does not let a quote in the name break the quoting', () => {
    expect(buildQuery({ ...TARGET, name: 'Fasade "Petrović"' })).toBe(
      '"Fasade Petrović" Novi Sad kontakt',
    );
  });
});

describe('the challenge', () => {
  it('recognises the real interstitial DuckDuckGo served this project', () => {
    expect(isChallenge(fixture('duckduckgo-challenge.html'))).toBe(true);
  });

  it('does not mistake a real result page for one', () => {
    expect(isChallenge(fixture('duckduckgo-results.html'))).toBe(false);
  });

  it('gives up rather than trying to get past it', async () => {
    const finder = new DuckDuckGoHtmlFinder();
    const body = fixture('duckduckgo-challenge.html');
    const http = {
      html: async () => ({ body, $: cheerio.load(body) }),
    } as unknown as import('../http/fetcher.js').PoliteFetcher;

    await expect(
      finder.search(TARGET, {
        http,
        log: { debug() {}, info() {}, warn() {}, error() {}, child: () => http as never } as never,
      }),
    ).rejects.toBeInstanceOf(SearchChallengedError);
  });
});

describe('parsing a result page', () => {
  const results = (): ReturnType<typeof parseDuckDuckGoResults> =>
    parseDuckDuckGoResults(cheerio.load(fixture('duckduckgo-results.html')), 5);

  it('unwraps the redirector and keeps the destination', () => {
    expect(results()[0]).toEqual({
      url: 'https://mikafasade.rs/kontakt',
      title: 'Kontakt | Mika Fasade',
      snippet: 'Termo fasade, Novi Sad. Telefon 064 123 4567.',
      rank: 1,
    });
  });

  it('keeps a direct link that is not wrapped', () => {
    expect(results().map((result) => result.url)).toContain(
      'https://neki-portal.rs/stovarista/novi-sad',
    );
  });

  it('drops the engine’s own navigation and its ad slots', () => {
    const urls = results().map((result) => result.url);
    expect(urls.some((url) => url.includes('duckduckgo.com'))).toBe(false);
    expect(urls).toHaveLength(3);
  });

  it('honours the limit it was given', () => {
    expect(
      parseDuckDuckGoResults(cheerio.load(fixture('duckduckgo-results.html')), 1),
    ).toHaveLength(1);
  });

  it('returns nothing rather than throwing on a page with no results in it', () => {
    expect(parseDuckDuckGoResults(cheerio.load('<html><body></body></html>'), 5)).toEqual([]);
  });
});

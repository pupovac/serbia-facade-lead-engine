import { describe, expect, it } from 'vitest';
import { acceptedPhones, extractPhones, rejectedPhones } from './extract.js';
import type { ExtractedPhone } from './types.js';

function e164s(found: readonly ExtractedPhone[]): string[] {
  return acceptedPhones(found).map((entry) => entry.phone?.e164 ?? '');
}

describe('extraction from prose', () => {
  it('finds a number a sentence is wrapped around', () => {
    expect(e164s(extractPhones('Fasaderski radovi, zovite 064/1234567 svaki dan.'))).toEqual([
      '+381641234567',
    ]);
  });

  it('finds every number in a string that holds several', () => {
    expect(e164s(extractPhones('064/123-4567, 021/456-789'))).toEqual([
      '+381641234567',
      '+38121456789',
    ]);
  });

  it('reads the obfuscated groupings Serbian pages use', () => {
    const text = 'Mob: 064 123 45 67 · Tel: 011/234-56-78 · Fiksni 021 456 789';
    expect(e164s(extractPhones(text))).toEqual(['+381641234567', '+381112345678', '+38121456789']);
  });

  it('does not swallow the street number in front of a phone', () => {
    const found = extractPhones('Vojvode Stepe 80-82, Beograd, tel 018 550907');
    expect(e164s(found)).toEqual(['+38118550907']);
    expect(found[0]?.raw).toBe('018 550907');
  });

  it('keeps a number that follows a house number without a comma', () => {
    expect(e164s(extractPhones('Bulevar oslobođenja 351 011 4065142'))).toEqual(['+381114065142']);
  });

  it('reports the same number once however often it appears', () => {
    const text = '064/123-4567 ... pozovite 064 123 4567 ili +381 64 123 4567';
    expect(e164s(extractPhones(text))).toEqual(['+381641234567']);
  });

  it('carries a context snippet a reviewer can judge the match by', () => {
    const found = extractPhones('Stovarište Gradnja, Novi Sad, telefon 021/456-789 radnim danima');
    expect(found[0]?.context).toContain('telefon 021/456-789');
    expect(found[0]?.origin).toBe('text');
  });
});

describe('what extraction refuses to call a phone', () => {
  it('walks past a PIB and a matični broj', () => {
    expect(extractPhones('PIB 101234567, MB 20123456')).toEqual([]);
  });

  it('walks past a labelled account number', () => {
    expect(extractPhones('žiro račun 160-0000000000000-00')).toEqual([]);
  });

  it('walks past dates, prices and opening hours', () => {
    expect(extractPhones('Osnovano 17.03.2004. Cena 150 000 RSD. Radno vreme 08 - 20.')).toEqual(
      [],
    );
  });

  it('walks past a postal code', () => {
    expect(extractPhones('Beograd 11000, Srbija')).toEqual([]);
  });

  it('keeps a number that is shaped like a phone but is not one, with the reason', () => {
    const rejected = rejectedPhones(extractPhones('Kontakt: 064 000 0000'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.error?.code).toBe('repeated-digits');
    expect(rejected[0]?.phone).toBeNull();
  });

  it('flags a foreign number instead of dropping or coercing it', () => {
    const rejected = rejectedPhones(extractPhones('Naš partner u Zagrebu: +385 91 234 5678'));
    expect(rejected[0]?.error).toMatchObject({ code: 'foreign', country: 'HR' });
  });
});

describe('extraction from HTML', () => {
  const page = `
    <html>
      <head>
        <meta itemprop="telephone" content="+381 11 2345 678" />
        <script type="application/ld+json">
          {"@type":"LocalBusiness","name":"Fasade Marković",
           "telephone":"+381641234567",
           "contactPoint":[{"@type":"ContactPoint","telephone":"021/456-789"}]}
        </script>
        <script type="application/ld+json">{ not valid json </script>
      </head>
      <body>
        <a href="tel:0641234567">Pozovite nas</a>
        <a href="tel:%2B381%2018%20550907">018 550907</a>
        <a href="https://example.rs/kontakt">Kontakt</a>
        <span itemprop="telephone">034/679-2660</span>
        <div data-phone="062 1131773">Mobilni</div>
        <p>Fiksni <span>011</span><span>2085506</span></p>
        <p>Fiksni 016 245104, PIB 101234567</p>
      </body>
    </html>`;

  const found = extractPhones(page, { html: true });

  it('reads tel: links, JSON-LD, meta, microdata, data attributes and visible text', () => {
    expect(e164s(found).sort()).toEqual([
      '+381112085506',
      '+381112345678',
      '+38116245104',
      '+38118550907',
      '+38121456789',
      '+381346792660',
      '+381621131773',
      '+381641234567',
    ]);
  });

  it('attributes each number to where it was actually found', () => {
    const origins = new Map(
      acceptedPhones(found).map((entry) => [entry.phone?.e164 ?? '', entry.origin]),
    );
    expect(origins.get('+381641234567')).toBe('tel-link');
    expect(origins.get('+38118550907')).toBe('tel-link');
    expect(origins.get('+38121456789')).toBe('json-ld');
    expect(origins.get('+381112345678')).toBe('meta');
    expect(origins.get('+381346792660')).toBe('microdata');
    expect(origins.get('+381621131773')).toBe('data-attribute');
    expect(origins.get('+38116245104')).toBe('text');
  });

  it('joins a number split across inline markup', () => {
    expect(e164s(found)).toContain('+381112085506');
  });

  it('keeps two numbers in neighbouring table cells apart', () => {
    const table = '<table><tr><td>064 123 4567</td><td>021 456 789</td></tr></table>';
    expect(e164s(extractPhones(table, { html: true }))).toEqual(['+381641234567', '+38121456789']);
  });

  it('survives a malformed JSON-LD block instead of throwing', () => {
    expect(e164s(found)).toContain('+38121456789');
  });

  it('ignores a link that is not a tel: link', () => {
    expect(found.every((entry) => !entry.context.includes('https://example.rs'))).toBe(true);
  });

  it('still walks past a PIB inside the page body', () => {
    expect(e164s(found)).not.toContain('+381101234567');
  });

  it('prefers the structured origin when a number appears twice', () => {
    const html = '<a href="tel:0641234567">064 123 4567</a><p>064 123 4567</p>';
    const single = extractPhones(html, { html: true });
    expect(single).toHaveLength(1);
    expect(single[0]?.origin).toBe('tel-link');
  });

  it('reads nothing structural unless told the input is HTML', () => {
    const link = '<a href="tel:0641234567">zovi nas</a>';
    expect(extractPhones(link).map((entry) => entry.origin)).toEqual(['text']);
    expect(extractPhones(link, { html: true }).map((entry) => entry.origin)).toEqual(['tel-link']);
  });
});

describe('edges the matcher has to hold', () => {
  it('reports a rejected number once, not once per appearance', () => {
    const found = extractPhones('Stari broj 064 000 0000, nekada 064 000 0000');
    expect(rejectedPhones(found)).toHaveLength(1);
  });

  it('walks past a digit run longer than any phone number', () => {
    expect(extractPhones('Referenca 012345678901234567890123')).toEqual([]);
  });

  it('ignores an empty structured value', () => {
    expect(extractPhones('<div data-phone="">nema</div>', { html: true })).toEqual([]);
  });

  it('ignores an anchor with no href and a meta with no content', () => {
    const html = '<a name="kontakt">Kontakt</a><meta name="telephone">';
    expect(extractPhones(html, { html: true })).toEqual([]);
  });

  it('reads past a JSON-LD field that is null or a number', () => {
    const html = `<script type="application/ld+json">
      {"telephone":null,"faxNumber":123,"contactPoint":{"telephone":"064/123-4567"}}
    </script>`;
    expect(e164s(extractPhones(html, { html: true }))).toEqual(['+381641234567']);
  });

  it('reads a JSON-LD document that is an array at the top level', () => {
    const html = '<script type="application/ld+json">[{"telephone":"021/456-789"}]</script>';
    expect(e164s(extractPhones(html, { html: true }))).toEqual(['+38121456789']);
  });

  it('ignores a JSON-LD string that is not a phone field', () => {
    const html = '<script type="application/ld+json">{"name":"064 123 4567"}</script>';
    expect(extractPhones(html, { html: true })).toEqual([]);
  });
});

describe('accepted and rejected helpers', () => {
  const found = extractPhones('Tel 064/123-4567, stari broj 064 000 0000');

  it('splits the list without losing anything', () => {
    expect(acceptedPhones(found)).toHaveLength(1);
    expect(rejectedPhones(found)).toHaveLength(1);
    expect(acceptedPhones(found).length + rejectedPhones(found).length).toBe(found.length);
  });
});

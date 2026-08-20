import { describe, expect, it } from 'vitest';
import {
  decodeCloudflareEmail,
  decodeNumericEntities,
  extractEmails,
  extractEmailsWithRejections,
} from './email.js';

const source = { sourceDomain: 'www.portal-srbija.com' };

describe('obfuscation forms', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['plain text', 'Kontakt: marko@fasade-bg.rs', 'marko@fasade-bg.rs'],
    ['mailto href', '<a href="mailto:bimax@bimax.rs">bimax@bimax.rs</a>', 'bimax@bimax.rs'],
    [
      'mailto with a subject',
      '<a href="mailto:info@firma.rs?subject=Upit">Pišite nam</a>',
      'info@firma.rs',
    ],
    ['percent-encoded mailto', '<a href="mailto:info%40firma.rs">mail</a>', 'info@firma.rs'],
    ['[at] and [dot]', 'marko [at] fasade-bg [dot] rs', 'marko@fasade-bg.rs'],
    ['(at) and (dot)', 'prodaja(at)stovariste(dot)co(dot)rs', 'prodaja@stovariste.co.rs'],
    ['{at}', 'office{at}termodom.rs', 'office@termodom.rs'],
    ['the word at', 'kontakt at fasade.rs', 'kontakt@fasade.rs'],
    ['Serbian tacka', 'kontakt(at)fasade(tacka)rs', 'kontakt@fasade.rs'],
    ['spaces around the at-sign', 'prodaja @ stovariste-nuto.com', 'prodaja@stovariste-nuto.com'],
    ['decimal entities', '&#107;&#111;ntakt&#64;termodom.rs', 'kontakt@termodom.rs'],
    ['hex entities', '&#x6B;ontakt&#x40;termodom.rs', 'kontakt@termodom.rs'],
    ['upper case', 'KONTAKT@FIRMA.RS', 'kontakt@firma.rs'],
  ];

  for (const [name, text, expected] of cases) {
    it(`reads ${name}`, () => {
      expect(extractEmails(text, source).map((email) => email.email)).toEqual([expected]);
    });
  }

  it('labels how each address was hidden', () => {
    const text = 'a@firma.rs, b [at] firma.rs, <a href="mailto:c@firma.rs">c</a>';
    const found = extractEmails(text, source);
    expect(found.map((email) => [email.email, email.obfuscation])).toEqual([
      ['a@firma.rs', 'none'],
      ['b@firma.rs', 'at-word'],
      ['c@firma.rs', 'mailto'],
    ]);
  });

  it('keeps the fragment each address came from', () => {
    const [email] = extractEmails('Pišite na marko [at] fasade-bg [dot] rs', source);
    expect(email?.raw).toBe('marko [at] fasade-bg [dot] rs');
  });
});

describe("Cloudflare's email protection", () => {
  // Copied verbatim from https://www.biznisgroup.rs/građevinarstvo/stovariste-gradevinskog-materijala-gradis-novi-pazar/
  const snippet =
    '<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="dab8b3a0b4b3a9b3b7bfb4b3b1a9a8b8b3b0bf9abdb7bbb3b6f4b9b5b7">[email&#160;protected]</a>';

  it('decodes the attribute', () => {
    expect(
      decodeCloudflareEmail('dab8b3a0b4b3a9b3b7bfb4b3b1a9a8b8b3b0bf9abdb7bbb3b6f4b9b5b7'),
    ).toBe('biznisimeniksrbije@gmail.com');
  });

  it('reads it out of the page', () => {
    const found = extractEmails(snippet, { sourceDomain: 'www.biznisgroup.rs' });
    expect(found.map((email) => [email.email, email.obfuscation])).toEqual([
      ['biznisimeniksrbije@gmail.com', 'cloudflare'],
    ]);
  });

  it('drops it once the source declares the address as its own', () => {
    const { emails, rejected } = extractEmailsWithRejections(snippet, {
      sourceDomain: 'www.biznisgroup.rs',
      sourceOwnedEmails: ['biznisimeniksrbije@gmail.com'],
    });
    expect(emails).toEqual([]);
    expect(rejected.map((entry) => entry.rule)).toEqual(['email_source_owned']);
  });

  it('returns null for a malformed payload', () => {
    expect(decodeCloudflareEmail('zz')).toBeNull();
  });
});

describe('decodeNumericEntities', () => {
  it('leaves text with no entities alone', () => {
    expect(decodeNumericEntities('kontakt@firma.rs')).toBe('kontakt@firma.rs');
  });

  it('leaves an entity it cannot resolve in place', () => {
    expect(decodeNumericEntities('&#xZZ;')).toBe('&#xZZ;');
  });
});

describe('rejection rules', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // The "send this listing to a friend" widget on gradjevinarstvo.rs.
    [
      'email_empty_mailto',
      '<a href="mailto:?subject=gradjevinarstvo.rs - AUSTROTHERM&body=https://x">Pošaljite</a>',
      'www.gradjevinarstvo.rs',
    ],
    ['email_invalid_syntax', '<a href="mailto:ime@@firma.rs">piši</a>', 'www.portal-srbija.com'],
    ['email_invalid_domain', '<a href="mailto:ime@localhost">piši</a>', 'www.portal-srbija.com'],
    ['email_asset_filename', '<img src="logo@2x.png">', 'www.portal-srbija.com'],
    ['email_placeholder', 'ime@example.com', 'www.portal-srbija.com'],
    ['email_noreply_mailbox', 'noreply@firma.rs', 'www.portal-srbija.com'],
    ['email_tracking_address', 'bounce+7f3a91c0d4e2@mg.sendgrid.net', 'www.portal-srbija.com'],
    ['email_directory_domain', 'info@portal-srbija.com', 'www.portal-srbija.com'],
  ];

  for (const [rule, text, sourceDomain] of cases) {
    it(`drops by ${rule}`, () => {
      const { emails, rejected } = extractEmailsWithRejections(text, { sourceDomain });
      expect(emails).toEqual([]);
      expect(rejected.map((entry) => entry.rule)).toContain(rule);
    });
  }

  it('drops the directory address but keeps the business one on the same page', () => {
    const page =
      'Firma: <a href="mailto:hemoluks@beotel.rs">hemoluks@beotel.rs</a> — portal: info@pttimenik.com, noreply@pttimenik.com';
    const { emails, rejected } = extractEmailsWithRejections(page, {
      sourceDomain: 'www.pttimenik.com',
    });
    expect(emails.map((email) => email.email)).toEqual(['hemoluks@beotel.rs']);
    expect(rejected.map((entry) => entry.rule).sort()).toEqual([
      'email_directory_domain',
      'email_noreply_mailbox',
    ]);
  });

  it('keeps a subdomain of the directory apart from the directory itself', () => {
    const found = extractEmails('prodaja@mojafirma.navidiku.rs', { sourceDomain: 'navidiku.rs' });
    expect(found).toEqual([]);
  });
});

describe('what is deliberately kept', () => {
  it('keeps free-provider and ISP addresses, flagged', () => {
    const found = extractEmails('fasade.mika@gmail.com i hemoluks@beotel.rs', source);
    expect(found.map((email) => [email.email, email.freeProvider])).toEqual([
      ['fasade.mika@gmail.com', true],
      ['hemoluks@beotel.rs', true],
    ]);
  });

  it('keeps role addresses on the business domain, flagged', () => {
    const [email] = extractEmails('info@fasade-bg.rs', source);
    expect(email?.role).toBe(true);
    expect(email?.registrableDomain).toBe('fasade-bg.rs');
  });

  it('keeps a plus-tagged personal address', () => {
    expect(extractEmails('marko+fasade@gmail.com', source).map((e) => e.email)).toEqual([
      'marko+fasade@gmail.com',
    ]);
  });
});

describe('real page text', () => {
  it('reads an address that ran into the next field in a meta description', () => {
    // pttimenik.com prints the whole listing into one meta tag, without spaces.
    const meta =
      'Telefon: 011 2341 505, 2341 480Fax: 2341 112PIB: 101993698Radno vreme 09:00 - 17hE-mail: hemoluks@beotel.rsWeb-site: www.hemoluks.com';
    expect(extractEmails(meta, { sourceDomain: 'www.pttimenik.com' }).map((e) => e.email)).toEqual([
      'hemoluks@beotel.rs',
    ]);
  });

  it("drops the manufacturer's own address when its distributor page is the source", () => {
    const block = 'Austrotherm d.o.o. Mirka Obradovića 31 SRB-14000 Valjevo office@austrotherm.rs';
    const { emails, rejected } = extractEmailsWithRejections(block, {
      sourceDomain: 'www.austrotherm.rs',
    });
    expect(emails).toEqual([]);
    expect(rejected[0]?.rule).toBe('email_directory_domain');
  });

  it('reads a mailto out of a link list without the surrounding HTML', () => {
    const found = extractEmails('', {
      sourceDomain: 'www.stovarista.rs',
      links: ['mailto:stovarista.srbije@gmail.com', 'http://www.ucpartizan.com/'],
    });
    expect(found.map((email) => email.email)).toEqual(['stovarista.srbije@gmail.com']);
  });

  it('reports the same address once, however many times the page prints it', () => {
    const page = '<a href="mailto:bimax@bimax.rs">bimax@bimax.rs</a> ... bimax@bimax.rs';
    expect(extractEmails(page, { sourceDomain: 'www.011info.com' })).toHaveLength(1);
  });
});

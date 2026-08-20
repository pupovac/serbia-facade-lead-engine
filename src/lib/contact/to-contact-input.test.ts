import { describe, expect, it } from 'vitest';
import { extractEmails } from './email.js';
import { extractSocials } from './social.js';
import { toContactInputs } from './to-contact-input.js';
import { extractWebsite } from './website.js';

const sourceDomain = 'www.011info.com';

describe('toContactInputs', () => {
  it('maps a full listing onto lead_contacts claims', () => {
    const page = '<a href="mailto:bimax@bimax.rs">bimax@bimax.rs</a>';
    const links = [
      { href: 'https://www.bimax.rs', text: 'www.bimax.rs' },
      { href: 'https://www.facebook.com/bimax.doo' },
      {
        href: 'https://www.google.com/maps/dir/?api=1&destination=44.848134,20.394314&travelmode=driving',
      },
    ];
    const contacts = toContactInputs({
      emails: extractEmails(page, { sourceDomain }),
      website: extractWebsite(links, { sourceDomain }),
      socials: extractSocials(links, { sourceDomain }),
    });

    expect(contacts).toEqual([
      {
        kind: 'email',
        value: 'bimax@bimax.rs',
        valueRaw: 'mailto:bimax@bimax.rs',
        domain: 'bimax.rs',
        handle: null,
        isPrimary: true,
        valid: true,
        confidence: 1,
      },
      {
        kind: 'website',
        value: 'https://bimax.rs',
        valueRaw: 'https://www.bimax.rs',
        domain: 'bimax.rs',
        handle: null,
        isPrimary: true,
        valid: true,
        confidence: 0.9,
      },
      {
        kind: 'facebook',
        value: 'https://www.facebook.com/bimax.doo',
        valueRaw: 'https://www.facebook.com/bimax.doo',
        domain: null,
        handle: 'bimax.doo',
        isPrimary: true,
        valid: true,
        confidence: 1,
      },
      {
        kind: 'google_maps',
        value: 'https://www.google.com/maps/search/?api=1&query=44.848134,20.394314',
        valueRaw:
          'https://www.google.com/maps/dir/?api=1&destination=44.848134,20.394314&travelmode=driving',
        domain: null,
        handle: '44.848134,20.394314',
        isPrimary: true,
        valid: true,
        confidence: 0.7,
      },
    ]);
  });

  it('stores no domain for a free or ISP mailbox, so dedup cannot merge on gmail.com', () => {
    const contacts = toContactInputs({
      emails: extractEmails('fasade.mika@gmail.com, hemoluks@beotel.rs, info@fasade-bg.rs', {
        sourceDomain,
      }),
    });
    expect(contacts.map((contact) => [contact.value, contact.domain])).toEqual([
      ['fasade.mika@gmail.com', null],
      ['hemoluks@beotel.rs', null],
      ['info@fasade-bg.rs', 'fasade-bg.rs'],
    ]);
  });

  it('makes the first personal address primary, not the role one', () => {
    const contacts = toContactInputs({
      emails: extractEmails('info@fasade-bg.rs i marko@fasade-bg.rs', { sourceDomain }),
    });
    expect(contacts.map((contact) => [contact.value, contact.isPrimary])).toEqual([
      ['info@fasade-bg.rs', false],
      ['marko@fasade-bg.rs', true],
    ]);
  });

  it('falls back to the role address when it is all there is', () => {
    const contacts = toContactInputs({
      emails: extractEmails('info@fasade-bg.rs', { sourceDomain }),
    });
    expect(contacts[0]?.isPrimary).toBe(true);
  });

  it('is less sure of an address it had to reassemble', () => {
    const contacts = toContactInputs({
      emails: extractEmails('marko [at] fasade-bg [dot] rs', { sourceDomain }),
    });
    expect(contacts[0]?.confidence).toBe(0.8);
  });

  it('uses the schema kinds, `google_maps` included', () => {
    const contacts = toContactInputs({
      socials: extractSocials([
        'https://www.instagram.com/fasade_bg/',
        'https://maps.app.goo.gl/aBcD1234',
      ]),
    });
    expect(contacts.map((contact) => contact.kind)).toEqual(['instagram', 'google_maps']);
    expect(contacts.map((contact) => contact.handle)).toEqual(['fasade_bg', 'aBcD1234']);
  });

  it('returns nothing when the page had nothing', () => {
    expect(toContactInputs({})).toEqual([]);
    expect(toContactInputs({ emails: [], website: null })).toEqual([]);
  });
});

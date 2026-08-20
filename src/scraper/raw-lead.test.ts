/**
 * The zod boundary.
 *
 * A record that fails here is reported and archived, never dropped — so what
 * these tests pin down is which records fail, and that a failure carries a
 * message someone can act on.
 */
import { describe, expect, it } from 'vitest';
import { validateRawLead } from './raw-lead.js';

const VALID = {
  sourceUrl: 'https://primer.rs/firme/termo-fasade',
  name: 'Termo Fasade Novi Sad d.o.o.',
};

describe('validateRawLead', () => {
  it('accepts the minimum: a name and the URL it was read at', () => {
    const result = validateRawLead(VALID, 'primer');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.sourceId).toBe('primer');
    // Defaults are applied, so downstream code never guards an optional array.
    expect(result.lead.phones).toEqual([]);
    expect(result.lead.links).toEqual([]);
    expect(result.lead.categories).toEqual([]);
    expect(result.lead.extra).toEqual({});
  });

  it('stamps the source id even when the adapter supplied a different one', () => {
    const result = validateRawLead({ ...VALID, sourceId: 'wrong' }, 'primer');

    expect(result.ok && result.lead.sourceId).toBe('primer');
  });

  it('keeps a lead that has no phone and no email', () => {
    // A name, a city and nothing else is still a lead worth reviewing.
    const result = validateRawLead({ ...VALID, city: 'Užice' }, 'primer');

    expect(result.ok).toBe(true);
  });

  it('rejects a record with no name', () => {
    const result = validateRawLead({ ...VALID, name: '   ' }, 'primer');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('name');
  });

  it('rejects a source URL that is not a URL', () => {
    const result = validateRawLead({ ...VALID, sourceUrl: '/firme/termo-fasade' }, 'primer');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('sourceUrl');
  });

  it('rejects coordinates that are not on Earth', () => {
    const result = validateRawLead({ ...VALID, latitude: 91, longitude: 20 }, 'primer');

    expect(result.ok).toBe(false);
  });

  it('keeps the failing payload so it can be archived', () => {
    const payload = { ...VALID, name: '' };
    const result = validateRawLead(payload, 'primer');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.value).toBe(payload);
  });

  it('rejects something that is not an object at all', () => {
    expect(validateRawLead('a string', 'primer').ok).toBe(false);
    expect(validateRawLead(null, 'primer').ok).toBe(false);
    expect(validateRawLead([VALID], 'primer').ok).toBe(false);
  });

  it('accepts a full record with links and raw phone strings', () => {
    const result = validateRawLead(
      {
        ...VALID,
        phones: ['021/456-789', '064 123 4567'],
        emails: ['info@termofasade.rs'],
        website: 'http://www.termofasade.rs',
        socials: ['https://www.facebook.com/termofasadens'],
        city: 'Novi Sad',
        address: 'Bulevar oslobođenja 112',
        categories: ['Fasaderski radovi'],
        links: [{ href: 'mailto:info@termofasade.rs', text: 'info@termofasade.rs' }],
        extra: { rank: 3 },
      },
      'primer',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Raw, exactly as published. Canonicalization happens downstream.
    expect(result.lead.phones).toEqual(['021/456-789', '064 123 4567']);
    expect(result.lead.extra).toEqual({ rank: 3 });
  });
});

import { describe, expect, it } from 'vitest';
import { classifyLead } from './classify.js';
import { DECISION_THRESHOLD, SIGNALS } from './signals.js';

describe('classifyLead — facade contractors', () => {
  const CONTRACTORS: readonly [string, string][] = [
    ['Fasaderski radovi Veljko', ''],
    ['SZR "Fasada" Novi Sad', 'Izrada demit fasada, termoizolacija stiroporom.'],
    ['Majstor Dragan', 'Izvodimo fasaderske radove, demit fasade i malterisanje.'],
    ['Termo Dom', 'Izrada fasada, postavljanje stiropora, završni radovi.'],
    ['Alpin Beograd', 'Sanacija fasada sa užeta, molersko-fasaderski radovi.'],
    ['Gradnja Petrović', 'Termo fasada, stiropor fasada, izvođenje radova na fasadi.'],
  ];

  it.each(CONTRACTORS)('labels %s as FACADE_CONTRACTOR', (name, description) => {
    const result = classifyLead({ name, description });
    expect(result.label).toBe('FACADE_CONTRACTOR');
    expect(result.contractor.net).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
    expect(result.evidence.some((e) => e.axis === 'contractor')).toBe(true);
  });

  it('reports the matched evidence, not just the label', () => {
    const result = classifyLead({
      name: 'Fasader Marković',
      description: 'Demit fasade i malterisanje, Čačak.',
    });
    const ids = result.evidence.map((e) => e.signalId);
    expect(ids).toContain('contractor.fasader');
    expect(ids).toContain('contractor.demit-fasada');
    expect(result.evidence[0]?.field).toBe('name');
    expect(result.reason).toContain('fasader');
  });
});

describe('classifyLead — construction-material stores', () => {
  const STORES: readonly [string, string][] = [
    ['Stovarište Gradnja', 'Prodaja građevinskog materijala.'],
    ['Farbara Kolaž', 'Boje i lakovi, lepkovi za stiropor.'],
    ['Gradjevinski centar Nikolić', 'Veleprodaja i maloprodaja građevinskog materijala.'],
    ['Izolacija Komerc', 'Stiropor, stirodur, mineralna vuna, kondor, cement.'],
    ['Termo Trade', 'Kod nas možete pronaći izolacioni materijal, veliki izbor.'],
  ];

  it.each(STORES)('labels %s as CONSTRUCTION_MATERIAL_STORE', (name, description) => {
    expect(classifyLead({ name, description }).label).toBe('CONSTRUCTION_MATERIAL_STORE');
  });

  it('reads a wide materials assortment as a yard even with no selling verb', () => {
    const result = classifyLead({
      name: 'Domis',
      description: 'Stiropor, stirodur, staklena vuna, kondor.',
    });
    expect(result.store.assortment).toBeGreaterThanOrEqual(3);
    expect(result.label).toBe('CONSTRUCTION_MATERIAL_STORE');
  });
});

describe('classifyLead — BOTH is a real label, not a tie-break', () => {
  it('labels a yard that also installs as BOTH', () => {
    const result = classifyLead({
      name: 'Krov Valjevo',
      description:
        'Prodaja: termoizolacioni materijali, boje i lakovi, materijal za završne radove. ' +
        'Usluge: fasaderski radovi, molersko-farbarski radovi.',
    });
    expect(result.label).toBe('BOTH');
    expect(result.contractor.net).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
    expect(result.store.net).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
  });

  it('does not force a single label when both axes are genuinely present', () => {
    const both = classifyLead({
      name: 'Stovarište i fasaderski radovi Jović',
      description: 'Prodaja građevinskog materijala i izrada demit fasada.',
    });
    expect(both.label).toBe('BOTH');
  });
});

/**
 * The four traps the brief names by hand. Each one publishes a word from the
 * contractor vocabulary and belongs to a different industry.
 */
describe('classifyLead — the named false positives', () => {
  it('does not label a roofing company as a facade contractor', () => {
    const result = classifyLead({
      name: 'Krovopokrivač Marić',
      description: 'Krovni pokrivači, krovopokrivački radovi, limarski radovi, termoizolacija.',
    });
    expect(result.label).not.toBe('FACADE_CONTRACTOR');
    expect(result.contractor.gateOpen).toBe(false);
  });

  it('does not label a window and aluminium company as a facade contractor', () => {
    const result = classifyLead({
      name: 'Profil Sistem',
      description:
        'Kapci, aluminijumske ograde, komarnici, roletne, prozori, ulazna vrata, ' +
        'alubond fasada, kontinualna fasada, strukturalna fasada.',
    });
    expect(result.label).toBe('UNKNOWN');
    expect(result.suppressed.some((s) => s.claimedBy === 'adjacent.joinery-fasada')).toBe(true);
  });

  it('does not label a waterproofing company as a facade contractor', () => {
    const result = classifyLead({
      name: 'Hidro Izolacija Beograd',
      description: 'Hidroizolacija ravnih krovova, bitumenske trake, parne brane, izolacija.',
    });
    expect(result.label).not.toBe('FACADE_CONTRACTOR');
  });

  it('does not label pipe and HVAC insulation as a facade contractor', () => {
    const result = classifyLead({
      name: 'Sidek Inženjering',
      description:
        'Armacell Armaflex, grejanje, kotlovi, rashladni sistemi, klimatizacija i ventilacija, ' +
        'izolacija - termoizolacija.',
    });
    expect(result.label).toBe('UNKNOWN');
  });

  it('does not label electrical insulation as a facade contractor', () => {
    const result = classifyLead({
      name: 'Elektro Materijal Doo',
      description: 'Kablovi, izolir trake, elektroizolacioni tepisi, elektro instalacije.',
    });
    expect(result.label).not.toBe('FACADE_CONTRACTOR');
  });

  it('does not label a facade-cleaning company as a facade contractor', () => {
    const result = classifyLead({
      name: 'Clean Windows Servis',
      categories: ['Čišćenje fasada, skidanje grafita'],
      description: 'Mašinsko pranje svih vrsta fasada, visinski radovi, čišćenje grafita.',
    });
    expect(result.label).toBe('UNKNOWN');
    expect(result.suppressed.some((s) => s.claimedBy === 'adjacent.cleaning-fasade')).toBe(true);
    expect(result.reason).toMatch(/another trade|Neither axis/);
  });

  it('reads `fasadna stolarija` as joinery, not as a facade', () => {
    const result = classifyLead({
      name: 'Info Market',
      description: 'Građevinski okovi za fasadnu stolariju, PVC i aluminijumske konstrukcije.',
    });
    expect(result.contractor.gateOpen).toBe(false);
    expect(result.label).toBe('UNKNOWN');
  });

  it('reads `fasadni materijal` as something a shop sells, not something a firm installs', () => {
    const result = classifyLead({
      name: 'Farbara Bimax',
      description: 'Boje i lakovi, fasadni materijal, molerski pribor i alat.',
    });
    expect(result.label).toBe('CONSTRUCTION_MATERIAL_STORE');
    expect(result.evidence.some((e) => e.signalId === 'store.fasadni-materijal')).toBe(true);
  });

  it('never turns insulation wording alone into a contractor label', () => {
    const result = classifyLead({
      categories: ['Termo izolacija, zvučna izolacija'],
      name: 'Termo Nešto',
      description: 'Termoizolacija, izolacija, termo izolacija, zvučna izolacija, termoizolacija.',
    });
    expect(result.contractor.gateOpen).toBe(false);
    expect(result.label).toBe('UNKNOWN');
    expect(result.reason).toContain('No facade term');
  });

  it('treats a manufacturer as a supplier rather than a buyer', () => {
    const result = classifyLead({
      name: 'Fima — fabrika izolacionih materijala',
      description: 'Fabrika izolacionih materijala i ambalaže, proizvodnja stiropora.',
    });
    expect(result.label).toBe('UNKNOWN');
    expect(result.store.vetoed).toBe(true);
  });

  it('keeps a yard that also manufactures — a counter outweighs a production line', () => {
    const result = classifyLead({
      name: 'Omega Impeks',
      description:
        'Građevinski materijal - cement, kreč, blok. Proizvodnja praškastih proizvoda. ' +
        'Stiropor svih vrsta, mineralna vuna, kondor.',
    });
    expect(result.label).toBe('CONSTRUCTION_MATERIAL_STORE');
  });
});

describe('classifyLead — mechanics', () => {
  it('is pure: the same input gives the same result twice', () => {
    const input = { name: 'Fasader Marković', description: 'Demit fasade, Čačak.' };
    expect(classifyLead(input)).toStrictEqual(classifyLead(input));
  });

  it('is diacritic-insensitive', () => {
    const withDiacritics = classifyLead({ name: 'Fasaderski radovi Čačak' });
    const folded = classifyLead({ name: 'Fasaderski radovi Cacak' });
    expect(folded.label).toBe(withDiacritics.label);
    expect(folded.contractor.net).toBe(withDiacritics.contractor.net);
  });

  it('reads Cyrillic through the same folding as everything else', () => {
    expect(classifyLead({ name: 'Фасадерски радови Марковић' }).label).toBe('UNKNOWN');
    // Cyrillic is transliterated by the name normalizer, not here; the raw
    // Cyrillic string is deliberately not a match, so callers must normalize.
  });

  it('returns UNKNOWN with high confidence for an empty record', () => {
    const result = classifyLead({});
    expect(result.label).toBe('UNKNOWN');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.evidence).toHaveLength(0);
  });

  it('scores a repeated term once per field', () => {
    const result = classifyLead({
      name: 'Stovarište',
      description: 'Stiropor, stiropor, stiropor, stiropor.',
    });
    const stiropor = result.evidence.filter((e) => e.signalId === 'store.stiropor');
    expect(stiropor).toHaveLength(1);
    expect(stiropor[0]?.occurrences).toBe(4);
  });

  it('weights the company name above the source category', () => {
    const inName = classifyLead({ name: 'Fasaderski radovi Petrović' });
    const inCategory = classifyLead({
      name: 'Moler Dragomir',
      categories: ['Molerski, fasaderski i gipsarski radovi'],
    });
    expect(inName.label).toBe('FACADE_CONTRACTOR');
    // A directory's category is a statement about the shelf, not the business.
    expect(inCategory.label).toBe('UNKNOWN');
  });

  it('gives every signal a unique id', () => {
    const ids = SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves overlapping matches longest-span-first', () => {
    const result = classifyLead({ description: 'Radimo čišćenje fasada u Beogradu.' });
    const claimed = result.evidence.map((e) => e.signalId);
    expect(claimed).toContain('adjacent.cleaning-fasade');
    expect(claimed).not.toContain('contractor.fasada');
    expect(result.suppressed).toContainEqual({
      field: 'description',
      matched: 'ciscenje fasada',
      claimedBy: 'adjacent.cleaning-fasade',
      suppressed: 'contractor.fasada',
    });
  });

  it('confidence rises with the margin over the threshold', () => {
    const thin = classifyLead({ description: 'Izrada fasada.' });
    const thick = classifyLead({
      name: 'Fasaderski radovi Jović',
      description: 'Demit fasade, termo fasada, izrada fasada, malterisanje.',
    });
    expect(thick.confidence).toBeGreaterThan(thin.confidence);
    expect(thick.confidence).toBeLessThanOrEqual(0.98);
  });
});

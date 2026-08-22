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
    const latin = classifyLead({ name: 'Fasaderski radovi Marković' });
    const cyrillic = classifyLead({ name: 'Фасадерски радови Марковић' });
    expect(latin.label).toBe('FACADE_CONTRACTOR');
    expect(cyrillic.label).toBe(latin.label);
    expect(cyrillic.contractor.net).toBe(latin.contractor.net);
  });

  // Directories publish the same company in three shapes — `Njegoš fasade`,
  // `NJEGOŠ FASADE`, `ЊЕГОШ ФАСАДЕ` — and a lead that reaches the salesperson
  // must not depend on which one the source chose. The digraphs are the
  // interesting part: `Nj`, `Lj` and `Dž` are one letter, and `Њ` upper-cased
  // beside another capital is `NJ`, not `Nj`.
  describe.each([
    [
      'nj digraph',
      'Njegoš fasade doo',
      'NJEGOŠ FASADE DOO',
      'Његош фасаде доо',
      'ЊЕГОШ ФАСАДЕ ДОО',
    ],
    [
      'lj digraph',
      'Ljubinko fasaderski radovi',
      'LJUBINKO FASADERSKI RADOVI',
      'Љубинко фасадерски радови',
      'ЉУБИНКО ФАСАДЕРСКИ РАДОВИ',
    ],
    [
      'dž digraph',
      'Džordže građevinsko stovarište',
      'DŽORDŽE GRAĐEVINSKO STOVARIŠTE',
      'Џорџе грађевинско стовариште',
      'ЏОРЏЕ ГРАЂЕВИНСКО СТОВАРИШТЕ',
    ],
    [
      'đ, word-final and mid-word',
      'Đorđ demit fasade',
      'ĐORĐ DEMIT FASADE',
      'Ђорђ демит фасаде',
      'ЂОРЂ ДЕМИТ ФАСАДЕ',
    ],
  ])('%s — one business, four spellings', (_name, mixed, caps, cyrillic, capsCyrillic) => {
    it('produces one label and one score', () => {
      const baseline = classifyLead({ name: mixed });
      for (const spelling of [caps, cyrillic, capsCyrillic]) {
        const result = classifyLead({ name: spelling });
        expect(result.label, spelling).toBe(baseline.label);
        expect(result.contractor.net, spelling).toBe(baseline.contractor.net);
        expect(result.store.net, spelling).toBe(baseline.store.net);
      }
    });
  });

  it('matches a term whichever case the source shouted it in', () => {
    const shouted = classifyLead({
      name: 'GRAĐEVINSKO STOVARIŠTE NJEGOŠ',
      description: 'PRODAJA STIROPORA, LEPKA I MREŽICE. VELEPRODAJA I MALOPRODAJA.',
    });
    const spoken = classifyLead({
      name: 'Građevinsko stovarište Njegoš',
      description: 'Prodaja stiropora, lepka i mrežice. Veleprodaja i maloprodaja.',
    });
    expect(shouted.label).toBe('CONSTRUCTION_MATERIAL_STORE');
    expect(shouted.label).toBe(spoken.label);
    expect(shouted.store.net).toBe(spoken.store.net);
  });

  it('reads the precomposed digraph code points as their two-letter forms', () => {
    // U+01C7..U+01CC. Rare, but a source that emits one would otherwise take
    // the whole word out of every keyword the classifier knows.
    const precomposed = classifyLead({ name: 'Ǉubinko fasaderski radovi' });
    expect(precomposed.label).toBe('FACADE_CONTRACTOR');
    expect(precomposed.contractor.net).toBe(
      classifyLead({ name: 'Ljubinko fasaderski radovi' }).contractor.net,
    );
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

/**
 * FUZZ-32 — the four recall changes, each pinned to the record that motivated
 * it in the pilot corpus, plus the two interactions that had to be resolved
 * before they were safe together.
 */
describe('classifyLead — FUZZ-32 recall changes', () => {
  describe('a facade term in the business name opens the contractor gate', () => {
    it('classifies `Ćorić Fasade`, whose only evidence is its own name', () => {
      const result = classifyLead({ name: 'Ćorić Fasade' });
      expect(result.label).toBe('FACADE_CONTRACTOR');
      // The same word in free text stays ambiguous and nets nothing on its own.
      expect(classifyLead({ description: 'Fasade.' }).label).toBe('UNKNOWN');
    });

    it('scores the name match as supporting, and says so in the evidence', () => {
      const result = classifyLead({ name: 'House fasade' });
      const fasada = result.evidence.find((e) => e.signalId === 'contractor.fasada');
      expect(fasada?.field).toBe('name');
      expect(fasada?.strength).toBe('supporting');
      expect(result.contractor.supporting).toBeCloseTo(1.25, 3);
      expect(result.contractor.ambiguous).toBe(0);
    });

    it('still needs a facade term — insulation in the name is not enough', () => {
      for (const name of ['Termoizolacija d.o.o.', 'Vlamil Izolacija', 'Termo plus Zrenjanin']) {
        const result = classifyLead({ name });
        expect(result.label, name).toBe('UNKNOWN');
        expect(result.contractor.gateOpen, name).toBe(false);
      }
    });

    it('does not rescue a facade word that belongs to another trade', () => {
      expect(classifyLead({ name: 'Fasadna stolarija Petrović' }).label).toBe('UNKNOWN');
      expect(classifyLead({ name: 'Pranje fasada Beograd' }).label).toBe('UNKNOWN');
    });
  });

  describe('moler is evidence, but never a label on its own', () => {
    it.each(['Moler Master', 'Bane moler', 'ULTRA Moler', 'Molerski Radovi GM Color'])(
      'records contractor evidence for %s and still returns UNKNOWN',
      (name) => {
        const result = classifyLead({ name });
        expect(result.evidence.map((e) => e.signalId)).toContain('contractor.moler');
        // A painter who never names a facade is a painter.
        expect(result.label).toBe('UNKNOWN');
      },
    );

    it('combines with a facade term into a facade crew', () => {
      const result = classifyLead({
        name: 'Dekor centar Babić',
        description: 'Molersko farbarski radovi, fasade, mašinsko malterisanje.',
      });
      expect(result.label).toBe('FACADE_CONTRACTOR');
      expect(result.evidence.map((e) => e.signalId)).toContain('contractor.moler');
    });

    it('reads `molersko-fasaderski radovi` in a name as one span', () => {
      const result = classifyLead({ name: 'Molersko Fasaderska Radnja Extermo' });
      expect(result.label).toBe('FACADE_CONTRACTOR');
      expect(result.evidence.map((e) => e.signalId)).toContain('contractor.molersko-fasaderski');
    });

    it('reads the same words in a source category as a shelf, not a claim', () => {
      // Poslovni Kontakt files painters, facade crews and plasterers together.
      const result = classifyLead({
        name: 'Moler Dragomir',
        categories: ['Molerski, fasaderski i gipsarski radovi'],
      });
      expect(result.label).toBe('UNKNOWN');
      expect(result.contractor.gateOpen).toBe(false);
      const shelf = result.evidence.find((e) => e.signalId === 'contractor.molersko-fasaderski');
      expect(shelf?.field).toBe('category');
    });
  });

  describe('scaffolding is the neighbouring trade', () => {
    it('suppresses `fasadne skele` the way `fasadna stolarija` is suppressed', () => {
      const result = classifyLead({ description: 'Iznajmljujemo fasadne skele.' });
      expect(result.label).toBe('UNKNOWN');
      expect(result.evidence.map((e) => e.signalId)).toContain('adjacent.scaffolding-fasade');
      expect(result.evidence.map((e) => e.signalId)).not.toContain('contractor.fasada');
      expect(result.contractor.gateOpen).toBe(false);
    });

    it('keeps `Topers`, a scaffolding-hire firm, out of the contractor label', () => {
      const result = classifyLead({
        name: 'Topers',
        categories: ['Završni radovi, restauracije', 'Gradjevinske skele', 'Platforme'],
        description:
          'TOPERS d.o.o je duži niz godina prepoznatljiv u oblasti građevinarstva po izvođenju završnih radova u građevinarstvu, a posebno po radovima na revitalizaciji/restauraciji i sanaciji fasada objekata koji su pod tretmanom Zavoda za zaštitu spomenika kulture.',
      });
      expect(result.label).toBe('UNKNOWN');
      expect(result.contractor.coreCancelled).toBeGreaterThan(0);
    });

    it('does not punish a facade contractor who erects his own scaffolding', () => {
      const result = classifyLead({
        name: 'Fasaderski radovi Jović',
        description: 'Izrada fasada, montaža skela, malterisanje.',
      });
      expect(result.label).toBe('FACADE_CONTRACTOR');
    });
  });

  describe("Overture's English taxonomy corroborates", () => {
    it.each([
      'building_or_construction_service',
      'contractor',
      'building_contractor',
      'painter',
      'plasterer',
    ])('records %s as supporting contractor evidence', (category) => {
      const result = classifyLead({ name: 'Neko preduzeće', categories: [category] });
      const hit = result.evidence.find((e) => e.signalId === 'contractor.source-category');
      expect(hit?.strength).toBe('supporting');
      // Never decisive on its own: the category names construction, not facades.
      expect(result.label).toBe('UNKNOWN');
    });

    it('does not fire on the tail of another trade’s category', () => {
      for (const category of ['paving_contractor', 'flooring_contractor']) {
        const result = classifyLead({ name: 'Neko preduzeće', categories: [category] });
        expect(
          result.evidence.map((e) => e.signalId),
          category,
        ).not.toContain('contractor.source-category');
      }
    });

    it('is decisive in combination with a Serbian facade term', () => {
      const bare = classifyLead({ name: 'Ćorić Fasade' });
      const withCategory = classifyLead({
        name: 'Ćorić Fasade',
        categories: ['building_or_construction_service'],
      });
      expect(withCategory.contractor.net).toBeGreaterThan(bare.contractor.net);
      expect(withCategory.label).toBe('FACADE_CONTRACTOR');
    });
  });
});

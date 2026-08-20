/**
 * The Serbian signal lexicon.
 *
 * Two things make this table work rather than a keyword list:
 *
 * 1. **The longest match over a span wins.** `čišćenje fasada` is longer than
 *    `fasada`, so a facade-washing company never scores facade-contractor
 *    evidence; `fasadna stolarija` is longer than `fasadn…`, so a window
 *    company never does either. Every false positive the brief warns about is
 *    handled by adding the *longer* phrase, not by adding an exception.
 * 2. **A gate, not a sum.** `termoizolacija` and `izolacija` can pile up
 *    without ever producing `FACADE_CONTRACTOR`, because neither opens the
 *    `facade` gate. That is the rule that keeps roofers, window fitters,
 *    waterproofers and pipe insulators out of the contractor label.
 *
 * All patterns are matched against text that has been folded to lower-case
 * ASCII by `src/lib/text/fold.ts`, so they are written `gradjevinski`,
 * `ciscenje`, `zavrsni` — never with diacritics.
 */
import type { AdjacentIndustry, ClassificationField, Signal } from './types.js';

/** Serbian is inflected, so a term is written as its stem and matched to the word end. */
function stem(...tokens: readonly string[]): RegExp {
  const body = tokens.map((t) => `${t}[a-z]*`).join('[\\s\\-/]+');
  return new RegExp(`(?<![a-z0-9])${body}`, 'g');
}

/** An exact word list, for stems whose inflections collide with another trade. */
function word(...words: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${words.join('|')})(?![a-z0-9])`, 'g');
}

/**
 * How much a field is trusted. A trade named in the company name is a
 * statement about the business; the same word in the twelfth line of a product
 * catalogue is a mention.
 *
 * `category` sits *below* `description` on purpose, and it was measured that
 * way: Poslovni Kontakt files every sole trader under
 * `Molerski, fasaderski i gipsarski radovi`, so at any weight that lets a
 * category decide on its own, ten painters become facade contractors. A source
 * taxonomy is a statement about the shelf, not about the business — it
 * corroborates, it never decides.
 */
export const FIELD_WEIGHTS: Readonly<Record<ClassificationField, number>> = {
  name: 2.5,
  category: 0.8,
  description: 1,
  website: 1.2,
  websiteText: 0.6,
};

/** An axis needs this much net evidence to produce a label. */
export const DECISION_THRESHOLD = 0.9;

/** Distinct building-material terms that make a business a materials seller on their own. */
export const ASSORTMENT_GATE = 3;

/** Bonus once the assortment gate is reached — a yard is its product list. */
export const ASSORTMENT_BONUS = 0.5;

/* -------------------------------------------------------------------------- */
/* Facade contractor                                                          */
/* -------------------------------------------------------------------------- */

const CONTRACTOR: readonly Signal[] = [
  {
    id: 'contractor.fasader',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [stem('fasader')],
    note: 'fasader, fasaderi, fasaderski radovi, molersko-fasaderski, fasaderske usluge',
  },
  {
    id: 'contractor.demit-fasada',
    axis: 'contractor',
    strength: 'core',
    weight: 1.1,
    gate: 'facade',
    patterns: [stem('demit', 'fasad'), stem('demit')],
    note: 'Demit is the Serbian shorthand for an ETICS facade. Nothing else uses the word.',
  },
  {
    id: 'contractor.termo-fasada',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [stem('termo', 'fasad'), stem('termicka', 'fasad'), stem('etics')],
  },
  {
    id: 'contractor.stiropor-fasada',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [
      stem('stiropor', 'fasad'),
      stem('fasad', 'od', 'stiropora'),
      stem('stiropor', 'za', 'fasad'),
    ],
  },
  {
    id: 'contractor.izrada-fasade',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [
      stem('izrada', 'fasad'),
      stem('izradu', 'fasad'),
      stem('postavljanje', 'fasad'),
      stem('montaza', 'fasad'),
      stem('radovi', 'na', 'fasad'),
      stem('radova', 'na', 'fasad'),
      stem('izvodjenje', 'fasad'),
    ],
  },
  {
    id: 'contractor.sanacija-fasade',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [
      stem('sanacij', 'fasad'),
      stem('sanaciji', 'fasad'),
      stem('restauracij', 'fasad'),
      stem('revitalizacij', 'fasad'),
      stem('obnova', 'fasad'),
      stem('sanacij', 'zidova', 'narocito', 'fasadnih'),
    ],
    note: 'Facade renovation is facade work. Facade *washing* is not — see adjacent.cleaning-fasade.',
  },
  {
    id: 'contractor.odrzavanje-fasade',
    axis: 'contractor',
    strength: 'core',
    weight: 0.95,
    gate: 'facade',
    patterns: [stem('odrzavanje', 'fasad')],
    note: 'Maintenance performed on facades, as opposed to washing them.',
  },
  {
    id: 'contractor.fasadne-obloge',
    axis: 'contractor',
    strength: 'core',
    weight: 1,
    gate: 'facade',
    patterns: [stem('fasadn', 'obloge'), stem('fasadn', 'oblog')],
  },
  {
    id: 'contractor.fasada',
    axis: 'contractor',
    strength: 'ambiguous',
    weight: 0.5,
    gate: 'facade',
    patterns: [stem('fasad')],
    note: 'The bare word. Opens the facade gate but never decides on its own.',
  },
  {
    id: 'contractor.termoizolacija',
    axis: 'contractor',
    strength: 'ambiguous',
    weight: 0.3,
    patterns: [stem('termoizolacij'), stem('termo', 'izolacij'), stem('termo-izolacij')],
    note: 'Deliberately gate-less: shared with roofing, joinery, HVAC and pipe insulation.',
  },
  {
    id: 'contractor.izolacija',
    axis: 'contractor',
    strength: 'ambiguous',
    weight: 0.15,
    patterns: [stem('izolacij'), stem('termoizolater')],
    note: 'Shared with waterproofing and electrical insulation. Gate-less on purpose.',
  },
  {
    id: 'contractor.malterisanje',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.4,
    patterns: [stem('malterisanj'), stem('masinsko', 'malterisanje'), stem('fasadni', 'malter')],
  },
  {
    id: 'contractor.izvodjenje-radova',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.35,
    patterns: [stem('izvodjenj'), stem('izvodimo'), stem('izvodjac'), stem('izvode')],
  },
  {
    id: 'contractor.ugradnja',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.3,
    patterns: [stem('ugradnj'), stem('postavljanj'), stem('oblaganj')],
  },
  {
    id: 'contractor.sanacija',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.25,
    patterns: [stem('sanacij'), stem('adaptacij'), stem('rekonstrukcij')],
  },
  {
    id: 'contractor.majstor',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.3,
    patterns: [stem('majstor')],
    note: 'Sole traders advertise as majstor rather than firma. Common in classifieds.',
  },
  {
    id: 'contractor.zavrsni-radovi',
    axis: 'contractor',
    strength: 'ambiguous',
    weight: 0.2,
    patterns: [stem('zavrsni', 'radov'), stem('zavrsnih', 'radov'), stem('zavrsne', 'radov')],
  },
  {
    id: 'contractor.visinski-radovi',
    axis: 'contractor',
    strength: 'supporting',
    weight: 0.2,
    patterns: [
      stem('visinsk', 'radov'),
      stem('radovi', 'na', 'visini'),
      stem('skele'),
      stem('alpinist'),
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Construction-material store                                                */
/* -------------------------------------------------------------------------- */

const STORE: readonly Signal[] = [
  {
    id: 'store.stovariste',
    axis: 'store',
    strength: 'core',
    weight: 1.2,
    gate: 'retail',
    patterns: [stem('stovarist'), stem('gradjevinsk', 'centar')],
  },
  {
    id: 'store.gradjevinski-materijal',
    axis: 'store',
    strength: 'core',
    weight: 1,
    gate: 'retail',
    patterns: [
      stem('gradjevinsk', 'materijal'),
      stem('gradjevinskog', 'materijala'),
      stem('gradjevinski', 'materijali'),
    ],
  },
  {
    id: 'store.farbara',
    axis: 'store',
    strength: 'core',
    weight: 0.95,
    gate: 'retail',
    patterns: [
      word('farbara', 'farbare', 'farbari', 'farbaru', 'farbarom', 'gvozdjara', 'gvozdjare'),
    ],
    note: 'A farbara is a paint-and-building-materials shop. `farbarski` is a painting trade — excluded.',
  },
  {
    id: 'store.veleprodaja',
    axis: 'store',
    strength: 'core',
    weight: 0.95,
    gate: 'retail',
    needsAssortment: true,
    patterns: [
      stem('veleprodaj'),
      stem('maloprodaj'),
      stem('prodajni', 'objek'),
      stem('trgovina', 'na', 'veliko'),
    ],
  },
  {
    id: 'store.distributer',
    axis: 'store',
    strength: 'supporting',
    weight: 0.5,
    gate: 'retail',
    patterns: [
      stem('distributer'),
      stem('distribucij'),
      stem('zastupnik'),
      stem('zastupamo'),
      stem('uvoznik'),
    ],
  },
  {
    id: 'store.prodaja',
    axis: 'store',
    strength: 'supporting',
    weight: 0.45,
    gate: 'retail',
    patterns: [stem('prodaj'), stem('trgovin'), stem('prodavnic')],
    note: 'Shared with every business that sells anything, so `prodaja stanova` and `prodaja placeva` are claimed by the general-construction signal instead.',
  },
  {
    id: 'store.radnja',
    axis: 'store',
    strength: 'supporting',
    weight: 0.6,
    gate: 'retail',
    patterns: [
      stem('kod', 'nas', 'mozete'),
      stem('mozete', 'pronaci', 'kod', 'nas'),
      stem('nasoj', 'radnji'),
      stem('nasem', 'maloprodajnom', 'objektu'),
      stem('radno', 'vreme'),
      stem('dodjite', 'i', 'uverite'),
      stem('posetite', 'nas'),
    ],
    note: 'How a walk-in shop describes itself. Opening hours on a listing mean a counter.',
  },
  {
    id: 'store.asortiman',
    axis: 'store',
    strength: 'supporting',
    weight: 0.3,
    patterns: [
      stem('asortiman'),
      stem('u', 'ponudi', 'imamo'),
      stem('nasoj', 'ponudi'),
      stem('siroka', 'ponuda'),
      stem('sirok', 'izbor'),
      stem('veliki', 'izbor'),
    ],
  },
  {
    id: 'store.fasadni-materijal',
    axis: 'store',
    strength: 'supporting',
    weight: 0.35,
    assortment: true,
    patterns: [
      stem('fasadn', 'materijal'),
      stem('fasadn', 'program'),
      stem('fasadn', 'sistem'),
      stem('fasadn', 'boj'),
      stem('fasadn', 'premaz'),
      stem('fasadn', 'mrezic'),
      stem('fasadn', 'lajsn'),
      stem('komplet', 'demit', 'fasad'),
      stem('za', 'demit', 'fasad'),
      stem('materijal', 'za', 'fasad'),
      stem('demit', 'program'),
    ],
    note: 'Longer than `fasad…` and than `demit fasada`, so a yard stocking facade systems is not read as a facade installer.',
  },
  {
    id: 'store.izolacioni-materijal',
    axis: 'store',
    strength: 'supporting',
    weight: 0.3,
    assortment: true,
    patterns: [
      stem('izolacion', 'materijal'),
      stem('termoizolacion', 'materijal'),
      stem('izolacioni', 'materijali'),
      stem('materijal', 'za', 'termo'),
      stem('materijal', 'za', 'izolacij'),
    ],
  },
  {
    id: 'store.stiropor',
    axis: 'store',
    strength: 'supporting',
    weight: 0.2,
    assortment: true,
    patterns: [stem('stiropor'), stem('stirodur'), word('xps')],
  },
  {
    id: 'store.mineralna-vuna',
    axis: 'store',
    strength: 'supporting',
    weight: 0.2,
    assortment: true,
    patterns: [
      stem('mineralna', 'vuna'),
      stem('kamena', 'vuna'),
      stem('staklena', 'vuna'),
      stem('mineralne', 'vune'),
    ],
  },
  {
    id: 'store.lepkovi',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [
      stem('lepkov'),
      stem('lepak', 'za'),
      stem('glet', 'mas'),
      stem('fug', 'mas'),
      stem('mrezic'),
    ],
  },
  {
    id: 'store.boje-i-lakovi',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [stem('boje', 'i', 'lakov'), stem('boja', 'i', 'lakova'), stem('disperzij')],
  },
  {
    id: 'store.grubi-materijal',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [
      stem('cement'),
      stem('opekarsk'),
      stem('betonska', 'galanterij'),
      stem('armaturn'),
      stem('siporeks'),
      stem('rezana', 'gradja'),
      stem('gips', 'ploc'),
      stem('gips', 'karton'),
    ],
  },
  {
    id: 'store.instalacioni-materijal',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [
      stem('vodovodn', 'materijal'),
      stem('kanalizacion', 'materijal'),
      stem('elektromaterijal'),
      stem('elektro', 'materijal'),
      stem('sanitarij'),
    ],
  },
  {
    id: 'store.alat',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [
      stem('srafovsk', 'rob'),
      stem('rucni', 'alat'),
      stem('elektricni', 'alat'),
      stem('molersk', 'alat'),
      stem('molerski', 'pribor'),
      stem('merdevin'),
    ],
  },
  {
    id: 'store.suva-gradnja',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [
      stem('suve', 'gradnje'),
      stem('suva', 'gradnja'),
      stem('masinsk', 'malter'),
      stem('gradjevinsk', 'folij'),
      stem('gradjevinsk', 'hemij'),
      stem('materijal', 'za', 'zavrsne', 'radov'),
    ],
  },
  {
    id: 'store.kondor',
    axis: 'store',
    strength: 'supporting',
    weight: 0.15,
    assortment: true,
    patterns: [word('kondor'), stem('ter', 'papir'), stem('bitumensk')],
  },
];

/* -------------------------------------------------------------------------- */
/* Adjacent industries — the false positives the brief names                  */
/* -------------------------------------------------------------------------- */

function adjacent(
  id: string,
  industry: AdjacentIndustry,
  weight: number,
  suppresses: readonly ('contractor' | 'store')[],
  patterns: readonly RegExp[],
  note?: string,
  cancelsCore = false,
): Signal {
  return {
    id,
    axis: 'adjacent',
    strength: 'supporting',
    weight,
    industry,
    suppresses,
    patterns,
    cancelsCore,
    ...(note === undefined ? {} : { note }),
  };
}

const ADJACENT: readonly Signal[] = [
  adjacent(
    'adjacent.cleaning-fasade',
    'cleaning',
    0.6,
    ['contractor'],
    [
      stem('ciscenj', 'fasad'),
      stem('ciscenje', 'i', 'pranje', 'fasad'),
      stem('pranj', 'fasad'),
      stem('pranje', 'i', 'ciscenje', 'fasad'),
      stem('pranje', 'i', 'peskiranje', 'fasad'),
      stem('pranje', 'prozora', 'i', 'fasad'),
      stem('pranje', 'i', 'zastita', 'fasad'),
      stem('masinsko', 'pranje', 'svih', 'vrsta', 'fasad'),
      stem('peskiranj', 'fasad'),
      stem('zastita', 'fasad'),
      stem('skidanje', 'grafita', 'sa', 'fasad'),
      stem('uklanjanje', 'grafita', 'sa', 'fasad'),
      stem('uklanjanje', 'boja', 'sa', 'krovova', 'i', 'fasad'),
      stem('grafita', 'i', 'zastita', 'svih', 'vrsta', 'fasad'),
      stem('spoljasnj', 'ciscenje', 'fasad'),
      stem('ciscenje', 'stakla', 'i', 'fasad'),
      stem('ciscenje', 'i', 'saniranje', 'fasad'),
    ],
    'Washing a facade is not building one. These phrases outrank the bare `fasada`.',
    true,
  ),
  adjacent(
    'adjacent.cleaning',
    'cleaning',
    0.5,
    ['contractor', 'store'],
    [
      stem('ciscenj'),
      stem('higijen'),
      stem('grafit'),
      stem('perionic'),
      stem('spremacic'),
      stem('hemijsko', 'ciscenje'),
    ],
  ),
  adjacent(
    'adjacent.joinery-fasada',
    'joinery',
    0.7,
    ['contractor', 'store'],
    [
      stem('fasadn', 'stolarij'),
      stem('alubond', 'fasad'),
      stem('kontinualn', 'fasad'),
      stem('strukturaln', 'fasad'),
      stem('polustrukturaln', 'fasad'),
      stem('staklen', 'fasad'),
      stem('alu', 'fasad'),
      stem('aluminijumsk', 'fasad'),
      word('alubond'),
      stem('kompozitn', 'materijal'),
      stem('kompozitn', 'panel'),
      stem('ventilirana', 'fasad'),
    ],
    'Curtain-wall, composite-panel and window work. The word is `fasada`, the trade is not ours — so this one cancels facade core evidence instead of merely discounting it.',
    true,
  ),
  adjacent(
    'adjacent.joinery',
    'joinery',
    0.45,
    ['contractor'],
    [
      stem('pvc', 'stolarij'),
      stem('alu', 'stolarij'),
      stem('aluminijumska', 'bravarij'),
      stem('roletn'),
      stem('komarnic'),
      stem('zaluzin'),
      stem('harmonika', 'vrat'),
      stem('okov', 'za', 'stolarij'),
      stem('termoizolacion', 'stakal'),
      stem('kapci'),
    ],
  ),
  adjacent(
    'adjacent.roofing',
    'roofing',
    0.35,
    ['contractor'],
    [
      stem('krovopokrivac'),
      stem('krovni', 'pokrivac'),
      stem('krovne', 'folij'),
      stem('krovna', 'konstrukcij'),
      stem('pokrivanje', 'krova'),
      stem('limarsk', 'radov'),
      stem('krovni', 'prozor'),
    ],
  ),
  adjacent(
    'adjacent.waterproofing',
    'waterproofing',
    0.3,
    ['contractor'],
    [stem('hidroizolacij'), stem('hidro', 'izolacij'), stem('parna', 'bran'), stem('parapropusn')],
  ),
  adjacent(
    'adjacent.industrial-insulation',
    'industrial_insulation',
    0.6,
    ['contractor', 'store'],
    [
      stem('klimatizacij'),
      stem('ventilacij'),
      stem('kotlarnic'),
      stem('kotlov'),
      stem('rashladn', 'sistem'),
      stem('predizolovan'),
      word('armaflex', 'armacell'),
      stem('izolacija', 'cevi'),
      stem('toplovod'),
      stem('termoenergetsk'),
      stem('termotehnick'),
      stem('gasn', 'instalacij'),
    ],
    'Pipe, plant and HVAC insulation — the other trade that lives on the word `termoizolacija`.',
  ),
  adjacent(
    'adjacent.electrical',
    'electrical',
    0.4,
    ['contractor'],
    [
      stem('elektroizolacion'),
      stem('izolir', 'trak'),
      stem('elektroinstalater'),
      stem('elektro', 'instalacij'),
    ],
  ),
  adjacent(
    'adjacent.manufacturing',
    'manufacturing',
    0.55,
    ['contractor', 'store'],
    [
      stem('fabrika'),
      stem('proizvodnj'),
      stem('proizvodjac'),
      stem('proizvodni', 'program'),
      stem('pogon'),
    ],
    'A factory is a supplier, not a buyer. Suppressed unless real retail evidence overrides it.',
  ),
  adjacent(
    'adjacent.other-trade',
    'other_trade',
    0.25,
    ['contractor'],
    [
      stem('parket'),
      stem('keramicar'),
      stem('vodoinstalater'),
      stem('gipsarsk'),
      stem('spusten', 'plafon'),
      stem('bravarsk', 'radov'),
      stem('stolarsk', 'radov'),
      stem('tesarsk', 'radov'),
      stem('podopolagac'),
      stem('odgusenj'),
      stem('kanalizacij'),
    ],
  ),
  adjacent(
    'adjacent.general-construction',
    'general_construction',
    0.3,
    ['contractor'],
    [
      stem('visokogradnj'),
      stem('niskogradnj'),
      stem('hidrogradnj'),
      stem('kljuc', 'u', 'ruke'),
      stem('izgradnja', 'objekata'),
      stem('prodaja', 'stanova'),
      stem('prodaja', 'placeva'),
      stem('projektovanj'),
      stem('geotehnick'),
    ],
  ),
  adjacent(
    'adjacent.technical-goods',
    'technical_goods',
    0.55,
    ['contractor', 'store'],
    [
      stem('tehnicka', 'guma'),
      stem('transportn', 'trak'),
      stem('zaptivk'),
      stem('penasti', 'materijal'),
      stem('teflon'),
      stem('metalne', 'konstrukcij'),
      stem('obojen', 'metal'),
      stem('zavesa'),
      stem('venecijaner'),
    ],
  ),
];

/** Every signal, in one table. Order does not matter — the matcher sorts by span length. */
export const SIGNALS: readonly Signal[] = [...CONTRACTOR, ...STORE, ...ADJACENT];

export const SIGNALS_BY_ID: ReadonlyMap<string, Signal> = new Map(SIGNALS.map((s) => [s.id, s]));

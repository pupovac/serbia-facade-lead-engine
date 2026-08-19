import { describe, expect, it } from 'vitest';
import {
  generateQueries,
  generateQueryPlan,
  generateTierQueries,
  locativePreposition,
  queryTemplates,
  templatesFor,
  termInventoryCounts,
  type QueryTemplate,
} from './queries.js';
import { municipalitiesInTier } from './geo.js';
import { foldDiacritics } from './text/fold.js';
import { hasCyrillic, toCyrillic } from './text/cyrillic.js';

const FIXTURE: readonly QueryTemplate[] = [
  { id: 'fasader', term: 'fasader', lead_types: ['FACADE_CONTRACTOR'], precision: 'narrow' },
  {
    id: 'gradjevinski-materijal',
    term: 'građevinski materijal',
    lead_types: ['CONSTRUCTION_MATERIAL_STORE'],
    precision: 'medium',
  },
  {
    id: 'termoizolacija',
    term: 'termoizolacija',
    lead_types: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
    precision: 'broad',
  },
  {
    id: 'baumit',
    term: 'Baumit distributer',
    lead_types: ['CONSTRUCTION_MATERIAL_STORE'],
    precision: 'medium',
    term_cyrillic: false,
  },
];

describe('term inventory', () => {
  it('meets the coverage floor for both lead types', () => {
    const counts = termInventoryCounts();
    expect(counts.byLeadType.FACADE_CONTRACTOR).toBeGreaterThanOrEqual(25);
    expect(counts.byLeadType.CONSTRUCTION_MATERIAL_STORE).toBeGreaterThanOrEqual(15);
  });

  it('tags every term with a precision and at least one lead type', () => {
    for (const template of queryTemplates) {
      expect(['narrow', 'medium', 'broad']).toContain(template.precision);
      expect(template.lead_types.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids and unique terms', () => {
    expect(new Set(queryTemplates.map((t) => t.id)).size).toBe(queryTemplates.length);
    expect(new Set(queryTemplates.map((t) => t.term)).size).toBe(queryTemplates.length);
  });

  it('stores every term in the diacritic spelling, never the folded one', () => {
    // `gradjevinski` in the inventory would silently halve the spelling coverage:
    // folding it again is a no-op, so the diacritic query would never be emitted.
    const suspicious = queryTemplates.filter((t) => /\bgradjev|dj[aeiou]/i.test(t.term));
    expect(suspicious).toEqual([]);
  });

  it('agrees with the counts recorded in its own _meta block', () => {
    const counts = termInventoryCounts();
    expect(counts.total).toBe(queryTemplates.length);
    expect(counts.byPrecision.narrow + counts.byPrecision.medium + counts.byPrecision.broad).toBe(
      counts.total,
    );
  });
});

describe('templatesFor', () => {
  it('returns only templates targeting the lead type', () => {
    for (const template of templatesFor('CONSTRUCTION_MATERIAL_STORE')) {
      expect(template.lead_types).toContain('CONSTRUCTION_MATERIAL_STORE');
    }
  });

  it('includes dual-purpose terms in both lead types', () => {
    const contractor = templatesFor('FACADE_CONTRACTOR').map((t) => t.id);
    const store = templatesFor('CONSTRUCTION_MATERIAL_STORE').map((t) => t.id);
    expect(contractor).toContain('termoizolacija');
    expect(store).toContain('termoizolacija');
  });

  it('orders narrow before medium before broad', () => {
    const rank = { narrow: 0, medium: 1, broad: 2 } as const;
    const ranks = templatesFor('FACADE_CONTRACTOR').map((t) => rank[t.precision]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('narrows by variant', () => {
    expect(templatesFor('FACADE_CONTRACTOR', 'narrow').every((t) => t.precision === 'narrow')).toBe(
      true,
    );
    expect(templatesFor('FACADE_CONTRACTOR', 'core').every((t) => t.precision !== 'broad')).toBe(
      true,
    );
    expect(templatesFor('FACADE_CONTRACTOR', 'all').length).toBeGreaterThan(
      templatesFor('FACADE_CONTRACTOR', 'core').length,
    );
  });
});

describe('generateQueries — spelling', () => {
  it('emits a diacritic and an ASCII-folded form of every query', () => {
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'cacak',
      variant: 'narrow',
      templates: FIXTURE,
    });
    expect(queries).toEqual(['fasader Čačak', 'fasader Cacak']);
  });

  it('folds the whole query, never half of it', () => {
    // `gradjevinski materijal Cacak`, not `građevinski materijal Cacak`.
    const queries = generateQueries({
      leadType: 'CONSTRUCTION_MATERIAL_STORE',
      municipality: 'cacak',
      variant: 'core',
      templates: FIXTURE,
    });
    expect(queries).toContain('građevinski materijal Čačak');
    expect(queries).toContain('gradjevinski materijal Cacak');
    expect(queries).not.toContain('gradjevinski materijal Čačak');
    expect(queries).not.toContain('građevinski materijal Cacak');
  });

  it('emits one query, not two, when the folded form is identical', () => {
    // Novi Sad has no diacritics, so the two spellings collapse.
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'novi-sad',
      variant: 'narrow',
      templates: FIXTURE,
    });
    expect(queries).toEqual(['fasader Novi Sad']);
  });

  it('folds a diacritic term even against a plain place name', () => {
    const queries = generateQueries({
      leadType: 'CONSTRUCTION_MATERIAL_STORE',
      municipality: 'novi-sad',
      variant: 'narrow',
      templates: [
        {
          id: 'gradjevinsko-stovariste',
          term: 'građevinsko stovarište',
          lead_types: ['CONSTRUCTION_MATERIAL_STORE'],
          precision: 'narrow',
        },
      ],
    });
    expect(queries).toEqual([
      'građevinsko stovarište Novi Sad',
      'gradjevinsko stovariste Novi Sad',
    ]);
  });

  it('keeps every real query in a spelling pair whose fold matches', () => {
    const plan = generateQueryPlan({
      leadType: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
      municipality: ['cacak', 'uzice', 'krusevac'],
      variant: 'all',
    });
    const folded = plan.filter((q) => q.folded);
    expect(folded.length).toBeGreaterThan(0);
    for (const query of folded) {
      expect(foldDiacritics(query.query)).toBe(query.query);
    }
  });
});

describe('generateQueries — inflection', () => {
  it('uses the locative, not the nominative, for the "u <city>" pattern', () => {
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'novi-sad',
      variant: 'all',
      templates: FIXTURE,
    });
    expect(queries).toContain('fasader Novi Sad'); // nominative
    expect(queries).toContain('fasader Novom Sadu'); // bare locative
    expect(queries).toContain('fasader u Novom Sadu'); // locative with preposition
    expect(queries).toContain('fasader Novog Sada'); // genitive
    expect(queries).not.toContain('fasader u Novi Sad');
  });

  it('inflects a two-word city name in both spellings', () => {
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'sremska-mitrovica',
      variant: 'all',
      templates: FIXTURE,
    });
    expect(queries).toContain('fasader u Sremskoj Mitrovici');
    expect(queries).toContain('fasader Sremske Mitrovice');
  });

  it('takes "na" for the Belgrade city municipalities that require it', () => {
    expect(locativePreposition('beograd-vracar')).toBe('na');
    expect(locativePreposition('beograd-novi-beograd')).toBe('na');
    expect(locativePreposition('novi-sad')).toBe('u');
    expect(locativePreposition('beograd-zemun')).toBe('u');

    const vracar = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'beograd-vracar',
      variant: 'core',
      templates: FIXTURE,
    });
    expect(vracar).toContain('fasader na Vračaru');
    expect(vracar).not.toContain('fasader u Vračaru');

    const zemun = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'beograd-zemun',
      variant: 'core',
      templates: FIXTURE,
    });
    expect(zemun).toContain('fasader u Zemunu');
  });

  it('produces a distinct locative for every tier-1 municipality', () => {
    // A dataset regression that dropped the inflected forms would silently
    // reduce every query to the nominative.
    for (const municipality of municipalitiesInTier(1)) {
      const queries = generateQueries({
        leadType: 'FACADE_CONTRACTOR',
        municipality: municipality.id,
        variant: 'all',
        templates: FIXTURE,
      });
      const locatives = queries.filter((q) => / (u|na) /.test(q));
      expect(locatives.length).toBeGreaterThan(0);
      expect(locatives.some((q) => q.endsWith(municipality.name_sr))).toBe(false);
    }
  });
});

describe('generateQueries — variants and scope', () => {
  it('widens monotonically from narrow to core to all', () => {
    const options = { leadType: 'FACADE_CONTRACTOR', municipality: 'novi-sad' } as const;
    const narrow = generateQueries({ ...options, variant: 'narrow' });
    const core = generateQueries({ ...options, variant: 'core' });
    const all = generateQueries({ ...options, variant: 'all' });
    expect(new Set(core)).toEqual(new Set([...core, ...narrow]));
    expect(new Set(all)).toEqual(new Set([...all, ...core]));
    expect(narrow.length).toBeLessThan(core.length);
    expect(core.length).toBeLessThan(all.length);
  });

  it('defaults to the core variant and Latin script', () => {
    const queries = generateQueries({ leadType: 'FACADE_CONTRACTOR', municipality: 'novi-sad' });
    expect(queries).toEqual(
      generateQueries({
        leadType: 'FACADE_CONTRACTOR',
        municipality: 'novi-sad',
        variant: 'core',
        scripts: ['latin'],
      }),
    );
    expect(queries.some(hasCyrillic)).toBe(false);
  });

  it('emits place-less queries when no municipality is given', () => {
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      variant: 'narrow',
      templates: FIXTURE,
    });
    expect(queries).toEqual(['fasader']);
  });

  it('accepts a slug, a nominative name, an inflected name or Cyrillic', () => {
    const bySlug = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'cacak',
      templates: FIXTURE,
    });
    for (const name of ['Čačak', 'Cacak', 'Čačku', 'Чачак']) {
      expect(
        generateQueries({ leadType: 'FACADE_CONTRACTOR', municipality: name, templates: FIXTURE }),
      ).toEqual(bySlug);
    }
  });

  it('throws on an unknown municipality rather than silently widening the search', () => {
    expect(() =>
      generateQueries({ leadType: 'FACADE_CONTRACTOR', municipality: 'zagreb' }),
    ).toThrow(/Unknown municipality/);
  });

  it('deduplicates across municipalities in a multi-city set', () => {
    const queries = generateQueries({
      leadType: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
      municipality: ['novi-sad', 'cacak', 'novi-sad'],
      variant: 'all',
    });
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('generateQueries — Cyrillic', () => {
  it('emits Cyrillic terms against Cyrillic place names', () => {
    const queries = generateQueries({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'novi-sad',
      variant: 'all',
      scripts: ['cyrillic'],
      templates: FIXTURE,
    });
    expect(queries).toContain('фасадер Нови Сад');
    expect(queries).toContain('фасадер у Новом Саду');
    expect(queries.every(hasCyrillic)).toBe(true);
  });

  it('never folds a Cyrillic query', () => {
    const plan = generateQueryPlan({
      leadType: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
      municipality: 'cacak',
      variant: 'all',
      scripts: ['cyrillic'],
    });
    expect(plan.every((q) => !q.folded)).toBe(true);
    expect(plan.some((q) => q.query.includes('Чачку'))).toBe(true);
  });

  it('suppresses Cyrillic for terms built on a Latin brand or acronym', () => {
    const queries = generateQueries({
      leadType: 'CONSTRUCTION_MATERIAL_STORE',
      municipality: 'novi-sad',
      variant: 'core',
      scripts: ['cyrillic'],
      templates: FIXTURE,
    });
    expect(queries.some((q) => q.includes('Baumit'))).toBe(false);
    expect(queries.some((q) => q.includes(toCyrillic('Baumit')))).toBe(false);
  });

  it('keeps both scripts separate when both are requested', () => {
    const plan = generateQueryPlan({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'novi-sad',
      variant: 'narrow',
      scripts: ['latin', 'cyrillic'],
      templates: FIXTURE,
    });
    expect(plan.map((q) => [q.script, q.query])).toEqual([
      ['latin', 'fasader Novi Sad'],
      ['cyrillic', 'фасадер Нови Сад'],
    ]);
  });
});

describe('generateQueryPlan — provenance and purity', () => {
  it('is pure: the same options produce the same array', () => {
    const options = {
      leadType: 'FACADE_CONTRACTOR',
      municipality: ['novi-sad', 'cacak'],
      variant: 'all',
      scripts: ['latin', 'cyrillic'],
    } as const;
    expect(generateQueryPlan(options)).toEqual(generateQueryPlan(options));
  });

  it('carries the template, precision, municipality and pattern of every query', () => {
    const plan = generateQueryPlan({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'cacak',
      variant: 'narrow',
      templates: FIXTURE,
    });
    expect(plan).toEqual([
      {
        query: 'fasader Čačak',
        template_id: 'fasader',
        lead_types: ['FACADE_CONTRACTOR'],
        precision: 'narrow',
        script: 'latin',
        municipality_id: 'cacak',
        pattern: 'nominative',
        folded: false,
      },
      {
        query: 'fasader Cacak',
        template_id: 'fasader',
        lead_types: ['FACADE_CONTRACTOR'],
        precision: 'narrow',
        script: 'latin',
        municipality_id: 'cacak',
        pattern: 'nominative',
        folded: true,
      },
    ]);
  });

  it('reports only the requested lead types on a dual-purpose term', () => {
    const plan = generateQueryPlan({
      leadType: 'FACADE_CONTRACTOR',
      municipality: 'novi-sad',
      variant: 'all',
      templates: FIXTURE,
    });
    const shared = plan.find((q) => q.template_id === 'termoizolacija');
    expect(shared?.lead_types).toEqual(['FACADE_CONTRACTOR']);
  });

  it('spends the first requests of each municipality on the narrowest terms', () => {
    const rank = { narrow: 0, medium: 1, broad: 2 } as const;
    const plan = generateQueryPlan({
      leadType: 'FACADE_CONTRACTOR',
      municipality: ['novi-sad', 'cacak'],
      variant: 'all',
    });
    const perMunicipality = new Map<string, number[]>();
    for (const query of plan) {
      const key = query.municipality_id ?? '';
      const ranks = perMunicipality.get(key) ?? [];
      ranks.push(rank[query.precision]);
      perMunicipality.set(key, ranks);
    }
    expect(perMunicipality.size).toBe(2);
    for (const ranks of perMunicipality.values()) {
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
    expect(plan[0]?.municipality_id).toBe('novi-sad');
  });

  it('never emits an empty or untrimmed query', () => {
    const plan = generateQueryPlan({
      leadType: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
      municipality: ['beograd', 'novi-sad', 'nis'],
      variant: 'all',
      scripts: ['latin', 'cyrillic'],
    });
    for (const query of plan) {
      expect(query.query).toBe(query.query.trim());
      expect(query.query).not.toMatch(/\s{2,}/);
      expect(query.query.length).toBeGreaterThan(0);
    }
  });
});

describe('generateTierQueries', () => {
  it('covers every tier-1 municipality and deduplicates the result', () => {
    const plan = generateTierQueries(1, {
      leadType: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
      variant: 'core',
    });
    const covered = new Set(plan.map((q) => q.municipality_id));
    expect(covered.size).toBe(municipalitiesInTier(1).length);
    expect(new Set(plan.map((q) => q.query)).size).toBe(plan.length);
  });

  it('grows with the variant and with the script set', () => {
    const options = { leadType: 'FACADE_CONTRACTOR' } as const;
    const core = generateTierQueries(1, { ...options, variant: 'core' });
    const all = generateTierQueries(1, { ...options, variant: 'all' });
    const bothScripts = generateTierQueries(1, {
      ...options,
      variant: 'core',
      scripts: ['latin', 'cyrillic'],
    });
    expect(all.length).toBeGreaterThan(core.length);
    expect(bothScripts.length).toBeGreaterThan(core.length);
  });
});

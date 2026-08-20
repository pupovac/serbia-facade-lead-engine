import { describe, expect, it } from 'vitest';
import { hasCyrillic, toCyrillic, toLatin } from './cyrillic.js';

describe('toCyrillic', () => {
  it('transliterates the query terms this project actually uses', () => {
    expect(toCyrillic('fasader')).toBe('фасадер');
    expect(toCyrillic('fasaderski radovi')).toBe('фасадерски радови');
    expect(toCyrillic('građevinski materijal')).toBe('грађевински материјал');
    expect(toCyrillic('građevinsko stovarište')).toBe('грађевинско стовариште');
    expect(toCyrillic('termoizolacija')).toBe('термоизолација');
    expect(toCyrillic('demit fasada')).toBe('демит фасада');
    expect(toCyrillic('izolacija kuće')).toBe('изолација куће');
    expect(toCyrillic('završni građevinski radovi')).toBe('завршни грађевински радови');
  });

  it('maps the digraphs before the single letters', () => {
    // Wrong order would give `лепљење` → `лепlјење` or `нј` for `nj`.
    expect(toCyrillic('lepljenje stiropora')).toBe('лепљење стиропора');
    expect(toCyrillic('konj')).toBe('коњ');
    expect(toCyrillic('džak')).toBe('џак');
    expect(toCyrillic('Njegoš')).toBe('Његош');
    expect(toCyrillic('LJUBAV')).toBe('ЉУБАВ');
  });

  it('preserves case', () => {
    expect(toCyrillic('Beograd')).toBe('Београд');
    expect(toCyrillic('BEOGRAD')).toBe('БЕОГРАД');
    expect(toCyrillic('Čačak')).toBe('Чачак');
  });

  it('leaves digits, punctuation and non-Serbian letters alone', () => {
    expect(toCyrillic('EPS 5 cm, 100x50')).toBe('ЕПС 5 цм, 100x50');
    expect(toCyrillic('q w x y')).toBe('q w x y');
  });

  it('takes the digraph reading even where a morpheme boundary would not', () => {
    // Documented limitation: `nadživeti` is `надживети` in real Serbian. Terms
    // hitting this class must set `term_cyrillic` in data/query-templates.json.
    expect(toCyrillic('nadživeti')).toBe('наџивети');
  });

  it('is idempotent on text that is already Cyrillic', () => {
    expect(toCyrillic('фасадер')).toBe('фасадер');
  });
});

describe('hasCyrillic', () => {
  it('separates the two scripts', () => {
    expect(hasCyrillic('фасадер')).toBe(true);
    expect(hasCyrillic('Нови Сад')).toBe(true);
    expect(hasCyrillic('fasader')).toBe(false);
    expect(hasCyrillic('Čačak')).toBe(false);
    expect(hasCyrillic('011 123 456')).toBe(false);
  });
});

describe('toLatin', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['фасадер', 'fasader'],
    ['грађевински материјал', 'građevinski materijal'],
    ['Фасада д.о.о. Београд', 'Fasada d.o.o. Beograd'],
    ['ЗАНАТСКА РАДЊА', 'ZANATSKA RADNJA'],
    ['Љубић', 'Ljubić'],
    ['ЉУБИЋ', 'LJUBIĆ'],
    ['Њива', 'Njiva'],
    ['Џеп', 'Džep'],
    ['Нови Сад 21000', 'Novi Sad 21000'],
    ['Fasada doo', 'Fasada doo'],
  ];

  for (const [input, expected] of cases) {
    it(`transliterates ${input} to ${expected}`, () => {
      expect(toLatin(input)).toBe(expected);
    });
  }

  it('round-trips every Serbian Latin term back to itself', () => {
    for (const term of ['fasader', 'građevinski materijal', 'stovarište', 'izolacija kuće']) {
      expect(toLatin(toCyrillic(term))).toBe(term);
    }
  });
});

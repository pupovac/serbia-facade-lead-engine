import { describe, expect, it } from 'vitest';
import { digraphCase } from './case.js';

describe('digraphCase', () => {
  it('reads the case from the letter after the digraph', () => {
    expect(digraphCase('ЊЕГОШ', 0)).toBe('upper');
    expect(digraphCase('Његош', 0)).toBe('title');
  });

  it('falls back to the letter before it at the end of a word', () => {
    expect(digraphCase('КОВИЉ', 4)).toBe('upper');
    expect(digraphCase('Ковиљ', 4)).toBe('title');
  });

  it('treats punctuation and whitespace as the end of the word', () => {
    expect(digraphCase('КОВИЉ, НОВИ САД', 4)).toBe('upper');
    expect(digraphCase('Ковиљ, Novi Sad', 4)).toBe('title');
  });

  it('takes the title form for a one-letter word with no neighbour', () => {
    expect(digraphCase('Љ', 0)).toBe('title');
    expect(digraphCase('- Љ -', 2)).toBe('title');
  });

  it('honours the length of the letter being expanded', () => {
    // `Đ` in `SMEĐ` is one code unit; the letter before it decides.
    expect(digraphCase('SMEĐ', 3, 1)).toBe('upper');
    expect(digraphCase('Smeđ', 3, 1)).toBe('title');
  });
});

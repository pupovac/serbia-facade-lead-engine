import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel, silentLogger } from './logger.js';

function collector(): { lines: string[]; sink: (level: string, line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (_level, line) => lines.push(line) };
}

describe('createLogger', () => {
  it('drops lines below the configured level', () => {
    const { lines, sink } = collector();
    const log = createLogger({ level: 'warn', sink });

    log.error('boom');
    log.warn('careful');
    log.info('fyi');
    log.debug('noise');

    expect(lines.map((line) => line.split(' ')[0])).toEqual(['error', 'warn']);
  });

  it('renders fields as key=value, skipping the undefined ones', () => {
    const { lines, sink } = collector();

    createLogger({ sink }).info('item failed', {
      url: 'https://primer.rs/x',
      status: 500,
      note: undefined,
    });

    expect(lines[0]).toContain('url=https://primer.rs/x status=500');
    expect(lines[0]).not.toContain('note');
  });

  it('nests child scopes so a line says which source and which page', () => {
    const { lines, sink } = collector();

    createLogger({ sink, scope: 'primer' }).child('http').info('fetched');

    expect(lines[0]).toContain('[primer:http] fetched');
  });

  it('has a silent logger for library callers', () => {
    expect(() => silentLogger.error('nothing is printed')).not.toThrow();
  });
});

describe('parseLogLevel', () => {
  it('accepts the four levels and falls back on anything else', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('  warn ')).toBe('warn');
    expect(parseLogLevel('chatty')).toBe('info');
    expect(parseLogLevel(undefined, 'error')).toBe('error');
  });
});

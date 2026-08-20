/**
 * Run-scoped logging.
 *
 * Small on purpose. A crawl's useful log is not a stream of prose, it is a
 * count of things that went wrong with the URL attached, so the interface is
 * four levels plus `child()` for the source/scope prefix and nothing else. The
 * orchestrator's summary — items discovered, extracted, failed, leads emitted,
 * requests made, wall time — is what a run is actually read by.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Structured detail attached to a line: `{ url, status }`, never a formatted string. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** A logger whose lines carry an extra prefix, e.g. the source id or a scope key. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly scope?: string;
  /** Where lines go. Tests pass a collector; the CLI passes `console`. */
  readonly sink?: (level: LogLevel, line: string) => void;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const candidate = (value ?? '').trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(candidate) ? (candidate as LogLevel) : fallback;
}

function consoleSink(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function render(fields: LogFields | undefined): string {
  if (fields === undefined) return '';
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? consoleSink;
  const scope = options.scope;
  const prefix = scope === undefined ? '' : `[${scope}] `;

  const emit = (lineLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (RANK[lineLevel] > RANK[level]) return;
    sink(lineLevel, `${lineLevel.padEnd(5)} ${prefix}${message}${render(fields)}`);
  };

  return {
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    child: (childScope) =>
      createLogger({
        level,
        scope: scope === undefined ? childScope : `${scope}:${childScope}`,
        sink,
      }),
  };
}

/** A logger that drops everything. `--dry-run` unit tests and library callers use it. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });

import { createHash } from 'node:crypto';

import { type LogLevel } from './config.js';

/**
 * Structured JSON logging: one line per event on stdout (CloudWatch Logs in Lambda). Fields are
 * identifiers, counts, codes and timings only — never prompts, model output, documents, memory content,
 * access codes or tokens (system design §3). The field type only admits primitives, and strings are
 * truncated, so an accidental object dump cannot happen.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose lines carry `bindings` as well. */
  child(bindings: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 1000;

export interface JsonLoggerOptions {
  readonly level?: LogLevel;
  /** Fields on every line (service, version). */
  readonly base?: LogFields;
  /** Line sink (defaults to stdout). */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

function clean(fields: LogFields | undefined, into: Record<string, string | number | boolean | null>): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    into[key] =
      typeof value === 'string' && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(line);
    });
  const now = options.now ?? (() => new Date());

  const build = (bindings: LogFields): Logger => {
    const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
      if (LEVELS[level] < threshold) return;
      const line: Record<string, string | number | boolean | null> = {
        level,
        time: now().toISOString(),
        event,
      };
      clean(options.base, line);
      clean(bindings, line);
      clean(fields, line);
      line.level = level;
      line.event = event;
      write(`${JSON.stringify(line)}\n`);
    };
    return {
      debug: (event, fields) => {
        emit('debug', event, fields);
      },
      info: (event, fields) => {
        emit('info', event, fields);
      },
      warn: (event, fields) => {
        emit('warn', event, fields);
      },
      error: (event, fields) => {
        emit('error', event, fields);
      },
      child: (more) => build({ ...bindings, ...more }),
    };
  };
  return build({});
}

/** Logger that drops everything (tests, tools). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** Pseudonymous principal identifier for logs (stable, not reversible to the id without a lookup table). */
export function principalHash(principalId: string): string {
  return createHash('sha256').update(`principal:${principalId.toLowerCase()}`).digest('hex').slice(0, 16);
}

/**
 * Error identity for logs: the class name and stack frames without the message line (driver and SDK
 * messages can echo row values or request content).
 */
export function errorFields(err: unknown): { errorName: string; stack: string | undefined } {
  if (!(err instanceof Error)) return { errorName: typeof err, stack: undefined };
  const frames = err.stack
    ?.split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 12)
    .join(' | ');
  return { errorName: err.name, stack: frames === '' ? undefined : frames };
}

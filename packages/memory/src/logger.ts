/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Lightweight debug logger for the memory package.
 *
 * Uses the same LogSink pattern as @funny/core/debug.ts — the server
 * wires this at startup to forward memory logs to Winston/OTLP.
 *
 * When no sink is set, logs go to console. When a sink is set,
 * logs forward to the sink only (same behavior as @funny/core).
 */

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface MemoryLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

type LogSink = (
  level: 'debug' | 'info' | 'warn' | 'error',
  namespace: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

let logSink: LogSink | null = null;

export function setMemoryLogSink(sink: LogSink | null): void {
  logSink = sink;
}

export function createMemoryLogger(namespace: string): MemoryLogger {
  const prefix = `[memory:${namespace}]`;

  const fmt = (msg: string, data?: Record<string, unknown>): string => {
    if (!data || Object.keys(data).length === 0) return `${prefix} ${msg}`;
    return `${prefix} ${msg} ${JSON.stringify(data)}`;
  };

  return {
    debug: (msg, data) => {
      if (logSink) {
        logSink('debug', `memory:${namespace}`, msg, data);
      } else {
        console.debug(fmt(msg, data));
      }
    },
    info: (msg, data) => {
      if (logSink) {
        logSink('info', `memory:${namespace}`, msg, data);
      } else {
        console.info(fmt(msg, data));
      }
    },
    warn: (msg, data) => {
      if (logSink) {
        logSink('warn', `memory:${namespace}`, msg, data);
      } else {
        console.warn(fmt(msg, data));
      }
    },
    error: (msg, data) => {
      if (logSink) {
        logSink('error', `memory:${namespace}`, msg, data);
      } else {
        console.error(fmt(msg, data));
      }
    },
  };
}

/** Module-level logger for quick imports */
export const log = createMemoryLogger('core');

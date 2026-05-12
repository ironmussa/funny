/**
 * Tiny console-backed logger satisfying `OrchestratorLogger`.
 *
 * Two output formats:
 *   - `text` (default) — readable single-line `[level] msg key=val ...`
 *   - `json`           — ndjson (one object per line, OTLP/log-aggregator friendly)
 *
 * For richer telemetry the standalone brain can swap this out for any
 * logger that conforms to `OrchestratorLogger` — keep the dependency
 * surface minimal here so the binary stays portable.
 */

import type { OrchestratorLogger } from './service.js';

export type LogFormat = 'text' | 'json';

export interface ConsoleLoggerOptions {
  format?: LogFormat;
  /** Minimum level to emit. Defaults to 'info'. */
  level?: 'debug' | 'info' | 'warn' | 'error';
}

const LEVEL_RANK: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createConsoleLogger(opts: ConsoleLoggerOptions = {}): OrchestratorLogger {
  const format: LogFormat = opts.format ?? 'text';
  const minRank = LEVEL_RANK[opts.level ?? 'info'];

  function emit(
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < minRank) return;
    if (format === 'json') {
      const line = JSON.stringify({
        level,
        msg,
        ts: new Date().toISOString(),
        ...(meta ?? {}),
      });
      writeLine(level, line);
    } else {
      const tail = meta && Object.keys(meta).length > 0 ? ' ' + formatMeta(meta) : '';
      writeLine(level, `[${level}] ${msg}${tail}`);
    }
  }

  return {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

function writeLine(level: string, line: string): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(' ');
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

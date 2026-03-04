/**
 * Lightweight debug logger for the core package.
 *
 * Uses console.debug/info/warn/error so it passes the pre-commit hook.
 * Controlled by the DEBUG_AGENT environment variable:
 *
 *   DEBUG_AGENT=1 bun run dev:server    # enable all agent debug logs
 *   DEBUG_AGENT=sdk,orch bun run dev    # enable only sdk + orchestrator
 *
 * When disabled (default), zero overhead — the functions are no-ops.
 */

const envFlag = process.env.DEBUG_AGENT ?? '';
const enableAll = envFlag === '1' || envFlag === '*' || envFlag === 'true';
const enabledNamespaces = enableAll
  ? null // null = all enabled
  : new Set(
      envFlag
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

function isEnabled(namespace: string): boolean {
  if (enableAll) return true;
  if (!enabledNamespaces || enabledNamespaces.size === 0) return false;
  return enabledNamespaces.has(namespace.toLowerCase());
}

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface DebugLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  enabled: boolean;
}

// ── Injectable log sink ─────────────────────────────────────────
// The server wires this at startup to forward core logs to Winston/OTLP.
// The sink always receives logs regardless of DEBUG_AGENT.

type LogSink = (
  level: 'debug' | 'info' | 'warn' | 'error',
  namespace: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

let logSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

export function createDebugLogger(namespace: string): DebugLogger {
  const enabled = isEnabled(namespace);
  const prefix = `[${namespace}]`;

  const fmt = (msg: string, data?: Record<string, unknown>): string => {
    if (!data || Object.keys(data).length === 0) return `${prefix} ${msg}`;
    return `${prefix} ${msg} ${JSON.stringify(data)}`;
  };

  return {
    enabled,
    debug: enabled
      ? (msg, data) => {
          console.debug(fmt(msg, data));
          logSink?.('debug', namespace, msg, data);
        }
      : (msg, data) => {
          logSink?.('debug', namespace, msg, data);
        },
    info: enabled
      ? (msg, data) => {
          console.info(fmt(msg, data));
          logSink?.('info', namespace, msg, data);
        }
      : (msg, data) => {
          logSink?.('info', namespace, msg, data);
        },
    warn: (msg, data) => {
      console.warn(fmt(msg, data));
      logSink?.('warn', namespace, msg, data);
    },
    error: (msg, data) => {
      console.error(fmt(msg, data));
      logSink?.('error', namespace, msg, data);
    },
  };
}

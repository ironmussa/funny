import {
  createLogger,
  interceptConsole,
  isConsoleIntercepted,
  type Logger,
} from '@abbacchio/browser-transport';

import { otlpEnabled, otlpEndpoint } from './otlp-config';

// ── Log levels ──────────────────────────────────────────────────
//
// Levels are persistent: prod ships with `info+` enabled by default so we
// always have signal in Abbacchio without redeploying. `debug` is reserved
// for high-frequency / noisy traces (every WS chunk, RAF flush, status
// transition) and stays off in prod unless a developer flips the localStorage
// toggle below — no need to add/remove log lines per investigation.
//
// Override at runtime (works in prod):
//   localStorage['funny:log-level'] = 'debug'   // global floor
//   localStorage['funny:log-ns:ws'] = 'debug'   // raise just the `ws` ns
//   delete localStorage['funny:log-level']      // back to default
//
// Writing localStorage by hand only takes effect on the next page load. The
// `__funnyLog` console API applies the change to the loggers that already exist
// and to the console capture, so it takes effect immediately:
//   __funnyLog.setLevel('debug')
//   __funnyLog.setNamespaceLevel('ws', 'debug')
//   __funnyLog.clearNamespaceLevel('ws')
//   __funnyLog.clear()
//
// The convention is encoded in `packages/client/CLAUDE.md` — do not change
// these keys or the default-level policy without updating that doc.

type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const VALID_LEVELS: readonly LevelName[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const GLOBAL_KEY = 'funny:log-level';
const NS_PREFIX = 'funny:log-ns:';

function readStored(key: string): LevelName | undefined {
  try {
    const v = localStorage.getItem(key);
    return v && (VALID_LEVELS as readonly string[]).includes(v) ? (v as LevelName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single source of truth for the client's log floor. Exported so the
 * `AbbacchioProvider` console capture in `main.tsx` ships at the same level as
 * the namespaced loggers instead of hardcoding one.
 */
export function resolveClientLogLevel(): LevelName {
  return readStored(GLOBAL_KEY) ?? (import.meta.env.PROD ? 'info' : 'debug');
}

let shared: Logger | null = null;

function getLogger(): Logger {
  if (!shared) {
    shared = createLogger({
      endpoint: otlpEndpoint ?? '',
      serviceName: 'funny-client',
      enabled: otlpEnabled,
      includeUrl: true,
      level: resolveClientLogLevel(),
    });
  }
  return shared;
}

/**
 * Retunes the `AbbacchioProvider` console capture. `interceptConsole` merges
 * options while capture is active, so the new floor applies immediately —
 * without remounting the provider or recreating the logger.
 */
function applyLevelToConsoleCapture(level: LevelName): void {
  if (isConsoleIntercepted()) interceptConsole({ level });
}

// Live namespaced loggers, one per namespace. Two purposes: the runtime toggles
// below can retune loggers that already exist, and repeated calls for the same
// namespace share an instance instead of allocating a new child each time.
//
// The registry is bounded by the number of namespaces because callers create
// their logger once at module scope.
const namespacedLoggers = new Map<string, Logger>();

/** A namespace override wins over the global floor; otherwise the floor applies. */
function effectiveLevelFor(namespace: string, globalLevel: LevelName): LevelName {
  return readStored(`${NS_PREFIX}${namespace}`) ?? globalLevel;
}

/**
 * Pushes the current floor and every namespace override onto the loggers that
 * already exist, plus the console capture.
 *
 * `Logger.child()` delegates through the prototype, so a child that has ever had
 * its own level set shadows the parent from then on. Rather than depend on that,
 * every level is assigned explicitly here — which is what makes both
 * `setNamespaceLevel` and `clear` take effect on live loggers.
 */
function applyLevels(): void {
  const globalLevel = resolveClientLogLevel();
  getLogger().setLevel(globalLevel);
  for (const [namespace, logger] of namespacedLoggers) {
    logger.setLevel(effectiveLevelFor(namespace, globalLevel));
  }
  applyLevelToConsoleCapture(globalLevel);
}

/** Non-React logger factory for Zustand stores and plain modules. */
export function createClientLogger(namespace: string) {
  const existing = namespacedLoggers.get(namespace);
  if (existing) return existing;

  const child = getLogger().child({ 'log.namespace': namespace });
  child.setLevel(effectiveLevelFor(namespace, resolveClientLogLevel()));
  namespacedLoggers.set(namespace, child);
  return child;
}

// Runtime control surface — available in prod via DevTools console.
if (typeof window !== 'undefined') {
  (window as any).__funnyLog = {
    setLevel(level: LevelName) {
      try {
        localStorage.setItem(GLOBAL_KEY, level);
      } catch {}
      applyLevels();
    },
    setNamespaceLevel(namespace: string, level: LevelName) {
      try {
        localStorage.setItem(`${NS_PREFIX}${namespace}`, level);
      } catch {}
      applyLevels();
    },
    /** Drops a namespace override so the namespace follows the global floor again. */
    clearNamespaceLevel(namespace: string) {
      try {
        localStorage.removeItem(`${NS_PREFIX}${namespace}`);
      } catch {}
      applyLevels();
    },
    clear() {
      try {
        localStorage.removeItem(GLOBAL_KEY);
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k?.startsWith(NS_PREFIX)) localStorage.removeItem(k);
        }
      } catch {}
      applyLevels();
    },
  };
}

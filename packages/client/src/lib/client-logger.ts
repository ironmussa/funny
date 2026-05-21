import { createLogger, type Logger } from '@abbacchio/browser-transport';

const endpoint = import.meta.env.VITE_OTLP_ENDPOINT as string | undefined;

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
// Or from the console: `__funnyLog.setLevel('debug')`.
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

function defaultLevel(): LevelName {
  return readStored(GLOBAL_KEY) ?? (import.meta.env.PROD ? 'info' : 'debug');
}

let shared: Logger | null = null;

function getLogger(): Logger {
  if (!shared) {
    shared = createLogger({
      endpoint: endpoint || 'http://localhost:4000',
      serviceName: 'funny-client',
      enabled: !!endpoint,
      includeUrl: true,
      level: defaultLevel(),
    });
  }
  return shared;
}

/** Non-React logger factory for Zustand stores and plain modules. */
export function createClientLogger(namespace: string) {
  const parent = getLogger();
  const child = parent.child({ 'log.namespace': namespace });
  const nsOverride = readStored(`${NS_PREFIX}${namespace}`);
  if (nsOverride) child.setLevel(nsOverride);
  return child;
}

// Runtime control surface — available in prod via DevTools console.
if (typeof window !== 'undefined') {
  (window as any).__funnyLog = {
    setLevel(level: LevelName) {
      try {
        localStorage.setItem(GLOBAL_KEY, level);
      } catch {}
      getLogger().setLevel(level);
    },
    setNamespaceLevel(namespace: string, level: LevelName) {
      try {
        localStorage.setItem(`${NS_PREFIX}${namespace}`, level);
      } catch {}
    },
    clear() {
      try {
        localStorage.removeItem(GLOBAL_KEY);
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k?.startsWith(NS_PREFIX)) localStorage.removeItem(k);
        }
      } catch {}
      getLogger().setLevel(defaultLevel());
    },
  };
}

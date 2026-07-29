import { beforeEach, describe, expect, it, vi } from 'vitest';

const interceptConsole = vi.fn();
const isConsoleIntercepted = vi.fn(() => true);
const setLevel = vi.fn();

/** Records every `setLevel` call made on a namespaced child logger. */
const childSetLevels: Array<{ namespace: string; level: string }> = [];

vi.mock('@abbacchio/browser-transport', () => ({
  createLogger: () => ({
    setLevel,
    child: (bindings: Record<string, unknown>) => {
      const namespace = String(bindings['log.namespace']);
      return {
        setLevel: (level: string) => childSetLevels.push({ namespace, level }),
      };
    },
  }),
  interceptConsole,
  isConsoleIntercepted,
}));

type FunnyLog = {
  setLevel: (level: string) => void;
  setNamespaceLevel: (namespace: string, level: string) => void;
  clearNamespaceLevel: (namespace: string) => void;
  clear: () => void;
};

async function loadLogger(): Promise<{
  funnyLog: FunnyLog;
  createClientLogger: (namespace: string) => unknown;
}> {
  const mod = await import('./client-logger');
  return {
    funnyLog: (window as unknown as { __funnyLog: FunnyLog }).__funnyLog,
    createClientLogger: mod.createClientLogger,
  };
}

describe('__funnyLog level control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childSetLevels.length = 0;
    isConsoleIntercepted.mockReturnValue(true);
    localStorage.clear();
    vi.resetModules();
  });

  it('retunes console capture as well as the namespaced loggers', async () => {
    const { funnyLog } = await loadLogger();

    funnyLog.setLevel('debug');

    expect(setLevel).toHaveBeenCalledWith('debug');
    expect(interceptConsole).toHaveBeenCalledWith({ level: 'debug' });
  });

  it('does not touch console capture when it is not active', async () => {
    isConsoleIntercepted.mockReturnValue(false);
    const { funnyLog } = await loadLogger();

    funnyLog.setLevel('warn');

    expect(setLevel).toHaveBeenCalledWith('warn');
    expect(interceptConsole).not.toHaveBeenCalled();
  });

  it('applies a namespace override to a logger that already exists', async () => {
    const { funnyLog, createClientLogger } = await loadLogger();
    createClientLogger('ws');
    childSetLevels.length = 0;

    funnyLog.setNamespaceLevel('ws', 'trace');

    expect(childSetLevels).toEqual([{ namespace: 'ws', level: 'trace' }]);
  });

  it('keeps the override when the global floor changes, and only that namespace', async () => {
    const { funnyLog, createClientLogger } = await loadLogger();
    createClientLogger('ws');
    createClientLogger('review');
    funnyLog.setNamespaceLevel('ws', 'trace');
    childSetLevels.length = 0;

    funnyLog.setLevel('error');

    expect(childSetLevels).toEqual([
      { namespace: 'ws', level: 'trace' },
      { namespace: 'review', level: 'error' },
    ]);
  });

  it('returns the namespace to the global floor on clearNamespaceLevel', async () => {
    const { funnyLog, createClientLogger } = await loadLogger();
    createClientLogger('ws');
    funnyLog.setNamespaceLevel('ws', 'trace');
    childSetLevels.length = 0;

    funnyLog.clearNamespaceLevel('ws');

    // Dev default is `debug`.
    expect(childSetLevels).toEqual([{ namespace: 'ws', level: 'debug' }]);
    expect(localStorage.getItem('funny:log-ns:ws')).toBeNull();
  });

  it('restores the default floor and drops overrides on clear', async () => {
    const { funnyLog, createClientLogger } = await loadLogger();
    createClientLogger('ws');
    funnyLog.setLevel('error');
    funnyLog.setNamespaceLevel('ws', 'trace');
    childSetLevels.length = 0;
    vi.clearAllMocks();

    funnyLog.clear();

    expect(setLevel).toHaveBeenCalledWith('debug');
    expect(childSetLevels).toEqual([{ namespace: 'ws', level: 'debug' }]);
    expect(interceptConsole).toHaveBeenCalledWith({ level: 'debug' });
    expect(localStorage.getItem('funny:log-level')).toBeNull();
    expect(localStorage.getItem('funny:log-ns:ws')).toBeNull();
  });

  it('reuses one logger per namespace and seeds it with the stored override', async () => {
    localStorage.setItem('funny:log-ns:ws', 'trace');
    const { createClientLogger } = await loadLogger();

    const first = createClientLogger('ws');
    const second = createClientLogger('ws');

    expect(second).toBe(first);
    expect(childSetLevels).toEqual([{ namespace: 'ws', level: 'trace' }]);
  });
});

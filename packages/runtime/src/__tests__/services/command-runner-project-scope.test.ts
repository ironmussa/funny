import { afterEach, describe, expect, test, vi, mock } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: vi.fn().mockResolvedValue({ id: 'project-a', userId: 'user-a' }),
    },
  }),
}));

mock.module('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser: vi.fn(),
  },
}));

mock.module('../../services/shutdown-manager.js', () => ({
  ShutdownPhase: { SERVICES: 'services' },
  shutdownManager: {
    register: vi.fn(),
  },
}));

import {
  getCommandMetricsForProject,
  isCommandRunningForProject,
  startCommand,
  stopAllCommands,
  stopCommand,
} from '../../services/command-runner.js';

describe('command-runner project scoping', () => {
  afterEach(async () => {
    await stopAllCommands();
  });

  test('status and metrics require the active command project id', async () => {
    // The command must end by itself. It runs in its own process group, so when
    // the test run is killed before `afterEach`, nothing else stops it.
    const result = await startCommand(
      'cmd-project-scope',
      'node -e "setTimeout(() => {}, 30000)"',
      process.cwd(),
      'project-a',
      'Scoped command',
    );

    expect(result.isOk()).toBe(true);
    expect(isCommandRunningForProject('cmd-project-scope', 'project-a')).toBe(true);
    expect(isCommandRunningForProject('cmd-project-scope', 'project-b')).toBe(false);
    expect(getCommandMetricsForProject('cmd-project-scope', 'project-a')).not.toBeNull();
    expect(getCommandMetricsForProject('cmd-project-scope', 'project-b')).toBeNull();
  });

  test.skipIf(process.platform === 'win32')(
    'a running command is on the ledger until it stops',
    async () => {
      const ledgerDir = join(process.env.FUNNY_DATA_DIR!, 'command-processes');
      const recorded = () => (existsSync(ledgerDir) ? readdirSync(ledgerDir) : []);

      const result = await startCommand(
        'cmd-ledger',
        'node -e "setTimeout(() => {}, 30000)"',
        process.cwd(),
        'project-a',
        'Ledger command',
      );
      expect(result.isOk()).toBe(true);
      expect(recorded()).toHaveLength(1);

      await stopCommand('cmd-ledger');
      expect(recorded()).toHaveLength(0);
    },
  );
});

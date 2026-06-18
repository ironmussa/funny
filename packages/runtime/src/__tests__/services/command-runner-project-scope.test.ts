import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: vi.fn().mockResolvedValue({ id: 'project-a', userId: 'user-a' }),
    },
  }),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser: vi.fn(),
  },
}));

vi.mock('../../services/shutdown-manager.js', () => ({
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
} from '../../services/command-runner.js';

describe('command-runner project scoping', () => {
  afterEach(async () => {
    await stopAllCommands();
  });

  test('status and metrics require the active command project id', async () => {
    const result = await startCommand(
      'cmd-project-scope',
      'node -e "setInterval(() => {}, 1000)"',
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
});

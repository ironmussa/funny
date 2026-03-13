/**
 * Pipeline handler wiring tests.
 *
 * Tests that pipeline handlers are correctly registered in the
 * handler-registry and respond to the expected events.
 */
import { describe, test, expect, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }));
vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => []),
          get: vi.fn(),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
  },
}));
vi.mock('../../services/agent-runner.js', () => ({
  startAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../services/thread-service.js', () => ({
  createAndStartThread: vi.fn(),
}));
vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: vi.fn(), broadcast: vi.fn() },
}));
vi.mock('../../services/thread-manager.js', () => ({
  getThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
  updateThread: vi.fn(),
}));
vi.mock('../../services/project-manager.js', () => ({
  getProject: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
vi.mock('../../services/pipeline-manager.js', () => ({
  getPipelineForProject: vi.fn(() => Promise.resolve(null)),
  startPipelineRun: vi.fn(),
}));
vi.mock('../../services/git-workflow-service.js', () => ({
  isWorkflowActive: vi.fn(() => false),
}));

import { pipelineTriggerHandler } from '../../services/handlers/pipeline-trigger-handler.js';

// ── Tests ────────────────────────────────────────────────────

describe('pipelineTriggerHandler', () => {
  test('has correct metadata', () => {
    expect(pipelineTriggerHandler.name).toBe('pipeline:trigger-on-commit');
    expect(pipelineTriggerHandler.event).toBe('git:committed');
  });

  test('action function is defined', () => {
    expect(typeof pipelineTriggerHandler.action).toBe('function');
  });

  test('returns silently for events without pipeline', async () => {
    await expect(
      pipelineTriggerHandler.action(
        {
          threadId: 't-1',
          userId: 'u-1',
          projectId: 'proj-1',
          message: 'test',
          cwd: '/tmp',
        },
        {} as any,
      ),
    ).resolves.toBeUndefined();
  });
});

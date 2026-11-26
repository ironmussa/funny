/**
 * The automation tools of the `funny` MCP server: what they send, that the
 * thread comes from the grant and never from the model, and that a server
 * refusal is a tool error the agent can read.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { Automation } from '@funny/shared';

import {
  automationToolDefinitions,
  describeAutomation,
} from '../../services/agent-automation-tools.js';

const request = vi.fn();
const THREAD = 'thread-1';

const tool = (name: string) => {
  const found = automationToolDefinitions({ threadId: THREAD, userId: 'alice' }, request).find(
    (definition) => definition.name === name,
  );
  if (!found) throw new Error(`${name} is not registered`);
  return async (args: Record<string, unknown>) => {
    const result = await found.run(args, undefined);
    const [first] = result.content;
    return { isError: result.isError, text: first.type === 'text' ? first.text : '' };
  };
};

const sampleAutomation: Automation = {
  id: 'auto-1',
  projectId: 'proj-1',
  userId: 'alice',
  name: 'Morning triage',
  prompt: 'Check open issues and summarize blockers.',
  schedule: '0 9 * * 1-5',
  provider: 'claude',
  model: 'sonnet',
  mode: 'worktree',
  permissionMode: 'autoEdit',
  baseBranch: 'main',
  enabled: true,
  maxRunHistory: 20,
  lastRunAt: '2026-11-25T09:00:00Z',
  nextRunAt: '2026-11-26T09:00:00Z',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-25T09:00:00Z',
};

beforeEach(() => request.mockReset());

describe('describeAutomation', () => {
  test('formats key fields and truncates long prompts', () => {
    const longPrompt = 'x'.repeat(250);
    const formatted = describeAutomation({ ...sampleAutomation, prompt: longPrompt });
    expect(formatted).toContain('• Morning triage (enabled) — id auto-1');
    expect(formatted).toContain('schedule: 0 9 * * 1-5');
    expect(formatted).toContain('model: claude/sonnet (worktree, autoEdit)');
    expect(formatted).toContain('base branch: main');
    expect(formatted).toContain(`prompt: ${'x'.repeat(200)}…`);
  });
});

describe('funny_automation_list', () => {
  test('lists automations for the granted thread', async () => {
    request.mockResolvedValue({ automations: [sampleAutomation] });
    const result = await tool('funny_automation_list')({});
    expect(request).toHaveBeenCalledWith('data:automation_list', { threadId: THREAD });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('1 automation(s):');
    expect(result.text).toContain('Morning triage (enabled) — id auto-1');
  });

  test('handles empty list, server refusal, and transport failure', async () => {
    request.mockResolvedValue({ automations: [] });
    expect((await tool('funny_automation_list')({})).text).toContain('no automations');

    request.mockResolvedValue({ error: 'refused', message: 'Not in a sandbox thread.' });
    expect(await tool('funny_automation_list')({})).toEqual({
      isError: true,
      text: 'Not in a sandbox thread.',
    });

    request.mockRejectedValue(new Error('transport down'));
    expect(await tool('funny_automation_list')({})).toEqual({
      isError: true,
      text: 'Could not list automations.',
    });
  });
});

describe('funny_automation_create', () => {
  test('always sends threadId from the grant and ignores model-supplied threadId', async () => {
    request.mockResolvedValue({ automation: sampleAutomation });
    const result = await tool('funny_automation_create')({
      name: 'Morning triage',
      prompt: 'Check open issues.',
      schedule: '0 9 * * 1-5',
      model: 'sonnet',
      threadId: 'other-thread',
      projectId: 'other-project',
    });
    expect(request).toHaveBeenCalledWith('data:automation_create', {
      name: 'Morning triage',
      prompt: 'Check open issues.',
      schedule: '0 9 * * 1-5',
      model: 'sonnet',
      threadId: THREAD,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('Created automation:');
    expect(result.text).toContain('auto-1');
  });
});

describe('funny_automation_update', () => {
  test('rejects an empty patch without hitting the server', async () => {
    const result = await tool('funny_automation_update')({ automationId: 'auto-1' });
    expect(request).not.toHaveBeenCalled();
    expect(result).toEqual({
      isError: true,
      text: 'Provide at least one field to update.',
    });
  });

  test('sends only allow-listed patch fields and granted threadId', async () => {
    request.mockResolvedValue({ automation: { ...sampleAutomation, enabled: false } });
    const result = await tool('funny_automation_update')({
      automationId: 'auto-1',
      enabled: false,
      schedule: '0 10 * * 1-5',
      projectId: 'hijack-project',
      threadId: 'hijack-thread',
    });
    expect(request).toHaveBeenCalledWith('data:automation_update', {
      automationId: 'auto-1',
      patch: { enabled: false, schedule: '0 10 * * 1-5' },
      threadId: THREAD,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('Updated automation:');
    expect(result.text).toContain('(disabled)');
  });
});

describe('funny_automation_delete', () => {
  test('sends automationId and granted threadId', async () => {
    request.mockResolvedValue({ id: 'auto-1', name: 'Morning triage' });
    const result = await tool('funny_automation_delete')({ automationId: 'auto-1' });
    expect(request).toHaveBeenCalledWith('data:automation_delete', {
      automationId: 'auto-1',
      threadId: THREAD,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe('Deleted automation "Morning triage" (auto-1).');
  });
});

describe('funny_automation_trigger', () => {
  test('sends automationId and formats runId and threadId', async () => {
    request.mockResolvedValue({
      runId: 'run-9',
      threadId: 'thread-9',
      name: 'Morning triage',
    });
    const result = await tool('funny_automation_trigger')({ automationId: 'auto-1' });
    expect(request).toHaveBeenCalledWith('data:automation_trigger', {
      automationId: 'auto-1',
      threadId: THREAD,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe('Triggered automation "Morning triage" (run run-9, thread thread-9).');
  });
});

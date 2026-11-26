/**
 * Access policy and boundary schemas for automation agent tools:
 * where they are refused, and that an agent can never move an automation
 * across projects.
 */
import { describe, expect, test } from 'bun:test';

import {
  agentCreateAutomationInput,
  agentUpdateAutomationPatch,
  automationToolAccess,
  type AutomationToolAction,
  type AutomationToolThread,
} from '../../services/automation-agent-tools.js';

const thread = (over: Partial<AutomationToolThread> = {}): AutomationToolThread => ({
  id: 't1',
  userId: 'alice',
  projectId: 'p1',
  isScratch: false,
  readOnly: false,
  runtime: 'local',
  source: 'web',
  ...over,
});

const facts = { runnerOwnerId: 'alice', sandboxRunner: false, steerShared: false };
const ALL: AutomationToolAction[] = ['list', 'create', 'update', 'delete', 'trigger'];

describe('automationToolAccess', () => {
  test("allows every action in the owner's own project thread", () => {
    for (const action of ALL) {
      expect(automationToolAccess(thread(), action, facts)).toBeNull();
    }
  });

  test('refuses every action in sandbox, read-only, scratch, factory, or automation threads', () => {
    const refusedThreads: Array<AutomationToolThread | null> = [
      thread({ runtime: 'sandbox' }),
      thread({ readOnly: true }),
      thread({ isScratch: true, projectId: null }),
      thread({ projectId: null }),
      thread({ source: 'factory' }),
      thread({ source: 'automation' }),
      null,
    ];
    for (const refused of refusedThreads) {
      for (const action of ALL) {
        expect(automationToolAccess(refused, action, facts)).toEqual(expect.any(String));
      }
    }
    expect(automationToolAccess(thread(), 'list', { ...facts, sandboxRunner: true })).toContain(
      'sandbox',
    );
  });

  test("another user's thread reads as not found", () => {
    expect(automationToolAccess(thread({ userId: 'bob' }), 'list', facts)).toBe(
      'Thread not found.',
    );
  });

  test('a thread shared for steering can list and refuses mutations', () => {
    const shared = { ...facts, steerShared: true };
    expect(automationToolAccess(thread(), 'list', shared)).toBeNull();
    for (const action of ['create', 'update', 'delete', 'trigger'] as const) {
      expect(automationToolAccess(thread(), action, shared)).toContain('shared for steering');
    }
  });
});

describe('automation agent schemas', () => {
  test('agentUpdateAutomationPatch rejects projectId and unknown keys', () => {
    const withProject = agentUpdateAutomationPatch.safeParse({
      name: 'Renamed',
      projectId: 'other-project',
    });
    expect(withProject.success).toBe(false);

    const valid = agentUpdateAutomationPatch.safeParse({
      name: 'Renamed',
      enabled: false,
    });
    expect(valid.success).toBe(true);
  });

  test('agentCreateAutomationInput validates required fields without projectId', () => {
    const valid = agentCreateAutomationInput.safeParse({
      name: 'Nightly check',
      prompt: 'Run checks',
      schedule: '0 2 * * *',
    });
    expect(valid.success).toBe(true);

    const missingSchedule = agentCreateAutomationInput.safeParse({
      name: 'Nightly check',
      prompt: 'Run checks',
    });
    expect(missingSchedule.success).toBe(false);
  });
});

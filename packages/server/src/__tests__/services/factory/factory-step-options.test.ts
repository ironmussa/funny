/**
 * The options a factory agent step runs with (openspec factory-flow-step-options,
 * task 2.1): override → step → flow defaults → project → factory defaults, every
 * field explicit, nothing carried from one step to the next.
 */

import { describe, expect, test } from 'bun:test';

import { getDefaultModel } from '@funny/shared/models';

import { resolveStepOptions } from '../../../services/factory/factory-step-options.js';

describe('resolveStepOptions', () => {
  test('a step with nothing set gets the factory defaults, every field explicit', () => {
    expect(resolveStepOptions({ stepId: 'implement', step: {} })).toEqual({
      stepId: 'implement',
      provider: 'claude',
      model: getDefaultModel('claude'),
      effort: null,
      permissionMode: 'autoEdit',
      allowedTools: null,
      disallowedTools: null,
      thread: 'continue',
    });
  });

  test('the project defaults come before the factory defaults', () => {
    const resolved = resolveStepOptions({
      stepId: 'implement',
      step: {},
      project: { provider: 'claude', model: 'sonnet', effort: 'low' },
    });
    expect(resolved).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'low' });
  });

  test('the flow defaults come before the project, the step before the flow defaults', () => {
    const flowDefaults = {
      model: 'sonnet',
      effort: 'medium' as const,
      permissionMode: 'plan',
      disallowedTools: ['WebFetch'],
    };
    const project = { model: 'haiku', effort: 'low' };
    expect(resolveStepOptions({ stepId: 'a', step: {}, flowDefaults, project })).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      permissionMode: 'plan',
      disallowedTools: ['WebFetch'],
    });
    expect(
      resolveStepOptions({
        stepId: 'a',
        step: { model: 'opus', effort: 'high', mode: 'autoEdit', disallowedTools: ['Bash'] },
        flowDefaults,
        project,
      }),
    ).toMatchObject({
      model: 'opus',
      effort: 'high',
      permissionMode: 'autoEdit',
      disallowedTools: ['Bash'],
    });
  });

  test('an override wins over the step for provider, model and effort only', () => {
    const resolved = resolveStepOptions({
      stepId: 'ci.before_retry',
      step: { model: 'opus', effort: 'high', mode: 'plan', disallowedTools: ['Bash'] },
      overrides: {
        'ci.before_retry': { model: 'haiku', effort: 'low' },
        implement: { model: 'x' },
      },
    });
    expect(resolved).toMatchObject({
      model: 'haiku',
      effort: 'low',
      permissionMode: 'plan',
      disallowedTools: ['Bash'],
    });
  });

  test("an override of the provider alone does not keep another provider's model", () => {
    const resolved = resolveStepOptions({
      stepId: 'implement',
      step: { model: 'opus' },
      overrides: { implement: { provider: 'codex' } },
    });
    expect(resolved.provider).toBe('codex');
    expect(resolved.model).toBe(getDefaultModel('codex'));
  });

  test('a project model of another provider is not used for the step', () => {
    const resolved = resolveStepOptions({
      stepId: 'implement',
      step: { provider: 'codex' },
      project: { provider: 'claude', model: 'sonnet' },
    });
    expect(resolved).toMatchObject({ provider: 'codex', model: getDefaultModel('codex') });
  });

  test('nothing leaks from one step to the next', () => {
    const flowDefaults = { model: 'sonnet' };
    const first = resolveStepOptions({
      stepId: 'implement',
      step: { model: 'opus', effort: 'max', disallowedTools: ['Bash'], mode: 'plan' },
      flowDefaults,
    });
    const next = resolveStepOptions({ stepId: 'ci.before_retry', step: {}, flowDefaults });
    expect(first).toMatchObject({ model: 'opus', effort: 'max', permissionMode: 'plan' });
    expect(next).toMatchObject({
      model: 'sonnet',
      effort: null,
      permissionMode: 'autoEdit',
      disallowedTools: null,
    });
  });

  test('thread: new is kept, and the default is continue', () => {
    expect(resolveStepOptions({ stepId: 'advise', step: { thread: 'new' } }).thread).toBe('new');
  });
});

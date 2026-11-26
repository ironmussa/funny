import { describe, expect, test } from 'bun:test';

import { startAgentCommandSchema } from '../../services/start-agent-command.js';

describe('startAgentCommandSchema', () => {
  test('reads a full StartAgentCommand in its proto3 JSON form', () => {
    expect(
      startAgentCommandSchema.parse({
        threadId: 't1',
        prompt: 'hi',
        cwd: '/repo',
        model: 'opus',
        provider: 'claude',
        permissionMode: 'autoEdit',
        images: ['aGk='],
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      }),
    ).toEqual({
      threadId: 't1',
      prompt: 'hi',
      cwd: '/repo',
      model: 'opus',
      provider: 'claude',
      permissionMode: 'autoEdit',
      images: ['aGk='],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
    });
  });

  test('omitted proto3 fields read as empty text and absent options', () => {
    expect(startAgentCommandSchema.parse({ threadId: 't1' })).toEqual({
      threadId: 't1',
      prompt: '',
      cwd: '',
      model: undefined,
      provider: undefined,
      permissionMode: undefined,
      images: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
    });
  });

  test('a field of the wrong type reads as absent instead of refusing the command', () => {
    const parsed = startAgentCommandSchema.parse({
      threadId: 42,
      model: '',
      provider: 7,
      allowedTools: 'Read',
    });
    expect(parsed.threadId).toBe('');
    expect(parsed.model).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.allowedTools).toBeUndefined();
  });

  // Read as absent, an unknown mode would start the agent with startAgent's
  // default (autoEdit): more than the thread was given.
  test('an unknown permission mode fails the command', () => {
    expect(
      startAgentCommandSchema.safeParse({ threadId: 't1', permissionMode: 'yolo' }).success,
    ).toBe(false);
    expect(
      startAgentCommandSchema.parse({ threadId: 't1', permissionMode: '' }).permissionMode,
    ).toBe(undefined);
  });

  test('a command that is not an object fails', () => {
    expect(startAgentCommandSchema.safeParse('start').success).toBe(false);
  });
});

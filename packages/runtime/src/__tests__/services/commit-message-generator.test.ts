import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { okAsync } from 'neverthrow';

const h = (() => ({
  query: vi.fn(),
  completeOnce: vi.fn(),
  getProfile: vi.fn(async (_userId: string): Promise<unknown> => null),
  getProviderKey: vi.fn(async (_userId: string, _provider: string): Promise<string | null> => null),
}))();
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: h.query }));
mock.module('@funny/core/agents', () => ({
  resolveSDKCliPath: () => '/sdk/cli.js',
  completeOnce: h.completeOnce,
}));
mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({
    profile: { getProfile: h.getProfile, getProviderKey: h.getProviderKey },
  }),
}));
mock.module('../../lib/logger.js', () => ({ log: { error: vi.fn() } }));
mock.module('../../services/pipeline-prompts.js', () => ({
  COMMIT_MESSAGE_SYSTEM_PROMPT: 'system',
}));

import { generateCommitMessage } from '../../services/commit-message-generator.js';

const options = { userId: 'user-1', cwd: '/repo', prompt: 'diff' };

function stream(messages: unknown[], failure?: Error) {
  const close = vi.fn();
  h.query.mockImplementation(() =>
    Object.assign(
      (async function* () {
        yield* messages;
        if (failure) throw failure;
      })(),
      { close },
    ),
  );
  return close;
}

describe('generateCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getProfile.mockImplementation(async () => null);
    h.getProviderKey.mockImplementation(async () => null);
  });

  test('prefers the result and closes the SDK query', async () => {
    const close = stream([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } },
      { type: 'result', result: 'TITLE: final' },
    ]);
    expect(await generateCommitMessage(options)).toEqual({ text: 'TITLE: final' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls[0][0].options).toMatchObject({
      cwd: '/repo',
      maxTurns: 1,
      tools: [],
      permissionMode: 'plan',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'system',
    });
    expect(h.getProfile).toHaveBeenCalledWith('user-1');
  });

  test('a non-default utility model reaches the LLM API backend, not the SDK', async () => {
    h.getProfile.mockImplementation(async () => ({
      utilityModel: { provider: 'openai', model: 'gpt-4o' },
    }));
    h.getProviderKey.mockImplementation(async () => 'sk-user');
    h.completeOnce.mockImplementation(() => okAsync('TITLE: from gpt'));
    expect(await generateCommitMessage(options)).toEqual({ text: 'TITLE: from gpt' });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.getProviderKey).toHaveBeenCalledWith('user-1', 'openai');
    expect(h.completeOnce.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-user',
      system: 'system',
      prompt: 'diff',
    });
  });

  test('an openai utility model without a key fails and tries no other provider', async () => {
    h.getProfile.mockImplementation(async () => ({
      utilityModel: { provider: 'openai', model: 'gpt-4o' },
    }));
    const output = await generateCommitMessage(options);
    expect('error' in output && output.error).toContain('openai');
    expect(h.query).not.toHaveBeenCalled();
    expect(h.completeOnce).not.toHaveBeenCalled();
  });

  test('falls back to assistant text', async () => {
    const close = stream([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'TITLE: draft' }] } },
      { type: 'result' },
    ]);
    expect(await generateCommitMessage(options)).toEqual({ text: 'TITLE: draft' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('reports empty output and closes the query', async () => {
    const close = stream([]);
    expect(await generateCommitMessage(options)).toEqual({ error: 'No output received' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('preserves provider failures and closes the query', async () => {
    const close = stream([], new Error('Invalid API key'));
    expect(await generateCommitMessage(options)).toEqual({ error: 'Invalid API key' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('does not start an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Disconnected'));
    expect(await generateCommitMessage({ ...options, signal: controller.signal })).toEqual({
      error: 'Disconnected',
    });
    expect(h.query).not.toHaveBeenCalled();
  });

  test.each(['timeout', 'disconnect'])('aborts and closes a pending query on %s', async (mode) => {
    const request = new AbortController();
    const close = vi.fn();
    let sdkSignal: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    h.query.mockImplementation(({ options: sdkOptions }) => {
      sdkSignal = sdkOptions.abortController.signal;
      return Object.assign(
        (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
          started.resolve();
          await new Promise<void>((_, reject) => {
            sdkSignal!.addEventListener('abort', () => reject(sdkSignal!.reason), { once: true });
          });
        })(),
        { close },
      );
    });
    const pending = generateCommitMessage({
      ...options,
      signal: request.signal,
      timeoutMs: mode === 'timeout' ? 30 : 5_000,
    });
    await started.promise;
    if (mode === 'disconnect') request.abort(new Error('Disconnected'));
    expect(await pending).toEqual({
      error: mode === 'timeout' ? 'Commit message generation timed out' : 'Disconnected',
    });
    expect(sdkSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

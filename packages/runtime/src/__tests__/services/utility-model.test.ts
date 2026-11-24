import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

const h = (() => ({
  query: vi.fn(),
  completeOnce: vi.fn(),
  getProviderKey: vi.fn(async (_userId: string, _provider: string): Promise<string | null> => null),
}))();
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: h.query }));
mock.module('@funny/core/agents', () => ({
  resolveSDKCliPath: () => '/sdk/cli.js',
  completeOnce: h.completeOnce,
}));
mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({ profile: { getProviderKey: h.getProviderKey } }),
}));

import type { UtilityGenerationOptions } from '../../services/utility-model.js';

// Loaded at test time, so a missing module fails an assertion, not the file load.
const utilityModule = await import('../../services/utility-model.js').catch(() => undefined);

function runUtilityGeneration(options: UtilityGenerationOptions) {
  expect(utilityModule?.runUtilityGeneration).toBeFunction();
  return utilityModule!.runUtilityGeneration(options);
}

const base = { userId: 'user-1', system: 'sys', prompt: 'hello' };

function sdkReplies(text: string) {
  const close = vi.fn();
  h.query.mockImplementation(() =>
    Object.assign(
      (async function* () {
        yield { type: 'result', result: text };
      })(),
      { close },
    ),
  );
  return close;
}

describe('runUtilityGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getProviderKey.mockImplementation(async () => null);
  });

  test('a null setting runs Claude Haiku through the SDK, one turn and no tools', async () => {
    const close = sdkReplies('recap');
    const result = await runUtilityGeneration({ ...base, setting: null, cwd: '/repo' });
    expect(result._unsafeUnwrap()).toBe('recap');
    expect(h.query.mock.calls[0][0].prompt).toBe('hello');
    expect(h.query.mock.calls[0][0].options).toMatchObject({
      cwd: '/repo',
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 1,
      tools: [],
      permissionMode: 'plan',
      systemPrompt: 'sys',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.completeOnce).not.toHaveBeenCalled();
    expect(h.getProviderKey).not.toHaveBeenCalled();
  });

  test('a claude-sdk setting passes a full model id through', async () => {
    sdkReplies('ok');
    await runUtilityGeneration({
      ...base,
      setting: { provider: 'claude-sdk', model: 'claude-sonnet-x' },
    });
    expect(h.query.mock.calls[0][0].options.model).toBe('claude-sonnet-x');
  });

  test('an LLM API setting calls completeOnce with the user key and model', async () => {
    h.getProviderKey.mockImplementation(async () => 'sk-user');
    h.completeOnce.mockImplementation(() => okAsync('from gpt'));
    const result = await runUtilityGeneration({
      ...base,
      setting: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(result._unsafeUnwrap()).toBe('from gpt');
    expect(h.getProviderKey).toHaveBeenCalledWith('user-1', 'openai');
    expect(h.completeOnce.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-user',
      system: 'sys',
      prompt: 'hello',
    });
    expect(h.query).not.toHaveBeenCalled();
  });

  test('passes the base URL of an ollama setting and asks for no key', async () => {
    h.completeOnce.mockImplementation(() => okAsync('llama says'));
    await runUtilityGeneration({
      ...base,
      setting: { provider: 'ollama', model: 'llama3', baseURL: 'http://gpu:11434/v1' },
    });
    expect(h.getProviderKey).not.toHaveBeenCalled();
    expect(h.completeOnce.mock.calls[0][0]).toMatchObject({
      provider: 'ollama',
      baseURL: 'http://gpu:11434/v1',
      apiKey: undefined,
    });
  });

  test.each(['openai', 'anthropic'] as const)(
    '%s without a saved key is utility-model-unavailable and nothing else runs',
    async (provider) => {
      const result = await runUtilityGeneration({ ...base, setting: { provider, model: 'm' } });
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'utility-model-unavailable', provider });
      expect(h.completeOnce).not.toHaveBeenCalled();
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  test('a provider failure is provider-error', async () => {
    h.getProviderKey.mockImplementation(async () => 'sk-user');
    h.completeOnce.mockImplementation(() =>
      errAsync({ kind: 'provider-error', message: 'the LLM endpoint returned 500', status: 500 }),
    );
    const result = await runUtilityGeneration({
      ...base,
      setting: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'provider-error',
      message: 'the LLM endpoint returned 500',
    });
  });

  test('a timeout aborts the fetch signal of the LLM API backend', async () => {
    h.getProviderKey.mockImplementation(async () => 'sk-user');
    let fetchSignal: AbortSignal | undefined;
    h.completeOnce.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      fetchSignal = signal;
      return ResultAsync.fromPromise(
        new Promise<string>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
        () => ({ kind: 'aborted', message: 'Aborted' }),
      );
    });
    const result = await runUtilityGeneration({
      ...base,
      setting: { provider: 'openai', model: 'gpt-4o' },
      timeoutMs: 30,
    });
    expect(result._unsafeUnwrapErr().kind).toBe('timeout');
    expect(fetchSignal?.aborted).toBe(true);
  });

  test('a timeout aborts and closes the SDK query', async () => {
    const close = vi.fn();
    let sdkSignal: AbortSignal | undefined;
    h.query.mockImplementation(({ options }) => {
      sdkSignal = options.abortController.signal;
      return Object.assign(
        (async function* () {
          yield { type: 'system' };
          await new Promise<void>((_, reject) =>
            sdkSignal!.addEventListener('abort', () => reject(sdkSignal!.reason), { once: true }),
          );
        })(),
        { close },
      );
    });
    const result = await runUtilityGeneration({ ...base, setting: null, timeoutMs: 30 });
    expect(result._unsafeUnwrapErr().kind).toBe('timeout');
    expect(sdkSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

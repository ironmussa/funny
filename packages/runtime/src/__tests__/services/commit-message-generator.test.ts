import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: h.query }));
vi.mock('@funny/core/agents', () => ({ resolveSDKCliPath: () => '/sdk/cli.js' }));
vi.mock('../../lib/logger.js', () => ({ log: { error: vi.fn() } }));
vi.mock('../../services/pipeline-prompts.js', () => ({ COMMIT_MESSAGE_SYSTEM_PROMPT: 'system' }));

import { generateCommitMessage } from '../../services/commit-message-generator.js';

const options = { cwd: '/repo', prompt: 'diff' };

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
  beforeEach(() => vi.clearAllMocks());

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
    });
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

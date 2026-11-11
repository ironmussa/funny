import { describe, expect, test } from 'bun:test';

import { err, errAsync, ok, okAsync } from 'neverthrow';

import type { SandboxErrorEventData } from '../../../services/thread-sandboxes/sandbox-events.js';
import type { SandboxLaunchRequest } from '../../../services/thread-sandboxes/sandbox-launch.js';
import {
  createSandboxThreadLauncher,
  type NewSandboxThreadRow,
  type FirstMessage,
  type RetryableSandboxThread,
} from '../../../services/thread-sandboxes/sandbox-thread.js';
import type { ProvisionError } from '../../../services/thread-sandboxes/thread-sandbox-service.js';
import type { ThreadSandboxRow } from '../../../services/thread-sandboxes/thread-sandbox-store.js';

const provisioned = { threadId: 't-new', runnerId: 'r-box' } as ThreadSandboxRow;

function setup(
  opts: {
    project?: { path: string } | null;
    refusal?: { code: string; message: string };
    provisionError?: ProvisionError;
    messageFails?: boolean;
    projectSandbox?: { connectionId: string; sizeId: string } | null;
    thread?: RetryableSandboxThread | null;
    /** The thread already has a message, so saveFirstMessage saves nothing. */
    hasMessages?: boolean;
    /** Images saved with the thread's first message. */
    firstImages?: unknown[];
    previousSandbox?: {
      connectionId: string;
      sizeId: string | null;
      repoUrl: string | null;
    } | null;
  } = {},
) {
  const inserted: NewSandboxThreadRow[] = [];
  const prepared: SandboxLaunchRequest[] = [];
  const messages: Array<{ userId: string; threadId: string; body: Record<string, unknown> }> = [];
  const failed: Array<[string, SandboxErrorEventData]> = [];
  const events: string[] = [];
  const recorded: FirstMessage[] = [];
  const launcher = createSandboxThreadLauncher({
    findOwnedProject: async (userId, projectId) =>
      opts.project !== undefined
        ? opts.project
        : userId === 'alice' && projectId === 'p1'
          ? { path: '/home/alice/app' }
          : null,
    projectSandbox: async (userId, projectId) =>
      userId === 'alice' && projectId === 'p1' ? (opts.projectSandbox ?? null) : null,
    prepare: async (req) => {
      prepared.push(req);
      if (opts.refusal) return err(opts.refusal);
      return ok({
        repoUrl: 'https://github.com/acme/app.git',
        provision: async () => (opts.provisionError ? err(opts.provisionError) : ok(provisioned)),
      });
    },
    insertThread: async (row) => {
      inserted.push(row);
    },
    loadThread: async (id) => ({ id, status: 'setting_up' }),
    findOwnedThread: async (userId, threadId) =>
      userId === 'alice' && threadId === 't-failed' ? (opts.thread ?? null) : null,
    previousSandbox: async () => opts.previousSandbox ?? null,
    saveFirstMessage: async (input) => {
      if (opts.hasMessages) return null;
      events.push(`first-message:${input.threadId}`);
      recorded.push(input);
      return 'm-first';
    },
    firstMessageImages: async (id) => (id === 't-failed' ? (opts.firstImages ?? null) : null),
    markSettingUp: async (id) => {
      events.push(`setting_up:${id}`);
    },
    markReady: async (id) => {
      events.push(`ready:${id}`);
    },
    markFailed: async (id, reason) => {
      failed.push([id, reason]);
    },
    sendMessage: (input) => {
      events.push(`message:${input.threadId}`);
      messages.push(input);
      return opts.messageFails ? errAsync('message failed (500)') : okAsync(undefined);
    },
    newId: () => 't-new',
    now: () => '2026-11-01T00:00:00.000Z',
  });
  return { launcher, inserted, prepared, messages, failed, events, recorded };
}

function expectOkCreate(result: { isOk(): boolean; isErr(): boolean } & object) {
  if (result.isErr()) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
}

const payload = {
  projectId: 'p1',
  prompt: 'Fix the login bug',
  model: 'opus',
  provider: 'claude',
  permissionMode: 'autoEdit',
  mode: 'worktree',
  images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
  sandbox: { connectionId: 'conn-1', sizeId: 'default' },
};

describe('sandbox thread creation', () => {
  test("without a connection it uses the caller's project sandbox (connection and size)", async () => {
    const { launcher, prepared } = setup({
      projectSandbox: { connectionId: 'conn-instabox', sizeId: 'large' },
    });
    const { sandbox: _sandbox, ...rest } = payload;
    expectOkCreate(await launcher.create('alice', rest));
    expect(prepared[0]).toMatchObject({ connectionId: 'conn-instabox', sizeId: 'large' });

    const sized = setup({ projectSandbox: { connectionId: 'conn-instabox', sizeId: 'large' } });
    expectOkCreate(await sized.launcher.create('alice', { ...rest, sandbox: { sizeId: 'small' } }));
    expect(sized.prepared[0]).toMatchObject({ connectionId: 'conn-instabox', sizeId: 'small' });
  });

  test('an explicit connection wins over the project sandbox', async () => {
    const { launcher, prepared } = setup({
      projectSandbox: { connectionId: 'conn-instabox', sizeId: 'large' },
    });
    expectOkCreate(await launcher.create('alice', payload));
    expect(prepared[0]).toMatchObject({ connectionId: 'conn-1', sizeId: 'default' });
  });

  test('without a connection or a project sandbox nothing is created (409)', async () => {
    const { launcher, inserted, prepared } = setup();
    const { sandbox: _sandbox, ...rest } = payload;
    const result = await launcher.create('alice', rest);
    expect(result.isErr() && result.error).toMatchObject({
      status: 409,
      code: 'project-sandbox-not-configured',
    });
    expect(prepared).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test('creates a local setting_up thread, provisions, then sends the prompt to the sandbox', async () => {
    const { launcher, inserted, prepared, messages, failed, events } = setup();
    const result = await launcher.create('alice', payload);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().thread).toEqual({ id: 't-new', status: 'setting_up' });

    expect(prepared).toEqual([
      {
        userId: 'alice',
        threadId: 't-new',
        projectId: 'p1',
        projectPath: '/home/alice/app',
        connectionId: 'conn-1',
        sizeId: 'default',
        repoUrl: undefined,
      },
    ]);
    // Worktree mode is ignored: the sandbox already isolates the thread.
    expect(inserted[0]).toMatchObject({
      id: 't-new',
      userId: 'alice',
      mode: 'local',
      runtime: 'sandbox',
      status: 'setting_up',
      stage: 'in_progress',
      title: 'Fix the login bug',
      initialPrompt: 'Fix the login bug',
    });

    await result._unsafeUnwrap().started;
    expect(messages).toEqual([
      {
        userId: 'alice',
        threadId: 't-new',
        body: {
          content: 'Fix the login bug',
          provider: 'claude',
          model: 'opus',
          permissionMode: 'autoEdit',
          images: payload.images,
          // The runner reuses the message the server saved instead of saving it again.
          savedMessageId: 'm-first',
        },
      },
    ]);
    expect(failed).toEqual([]);
    // The agent can only start from `pending`: the thread leaves setting_up first.
    expect(events).toEqual(['first-message:t-new', 'ready:t-new', 'message:t-new']);
  });

  test('records the chosen base branch on the thread and checks it out in the sandbox', async () => {
    const { launcher, inserted, prepared } = setup();
    expectOkCreate(await launcher.create('alice', { ...payload, baseBranch: 'feature/login' }));
    // On the row from the start, so the first message already shows the branch.
    expect(inserted[0]).toMatchObject({ baseBranch: 'feature/login' });
    expect(prepared[0]).toMatchObject({ branch: 'feature/login' });
  });

  test('saves the first message with the thread, before the sandbox is up', async () => {
    const { launcher, recorded } = setup({
      provisionError: { kind: 'checkout', message: 'clone failed' },
    });
    await (await launcher.create('alice', payload))._unsafeUnwrap().started;
    // The sandbox never came up, yet the prompt (and its images) is a message.
    expect(recorded).toEqual([
      {
        userId: 'alice',
        threadId: 't-new',
        content: 'Fix the login bug',
        timestamp: '2026-11-01T00:00:00.000Z',
        images: payload.images,
        model: 'opus',
        permissionMode: 'autoEdit',
        effort: undefined,
      },
    ]);
  });

  test('without a saved first message the runner saves it as before', async () => {
    const { launcher, messages } = setup({ hasMessages: true });
    await (await launcher.create('alice', payload))._unsafeUnwrap().started;
    expect(messages[0].body.savedMessageId).toBeUndefined();
  });

  test('a refused launch creates nothing', async () => {
    const { launcher, inserted } = setup({
      refusal: { code: 'repo-url-unknown', message: 'no repo' },
    });
    const result = await launcher.create('alice', payload);
    expect(result._unsafeUnwrapErr()).toEqual({
      status: 409,
      code: 'repo-url-unknown',
      message: 'no repo',
    });
    expect(inserted).toEqual([]);
  });

  test("another user's project is not found", async () => {
    const { launcher, prepared, inserted } = setup();
    const result = await launcher.create('mallory', payload);
    expect(result._unsafeUnwrapErr().status).toBe(404);
    expect(prepared).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test('rejects a provider the sandbox has no credential for', async () => {
    const { launcher, prepared } = setup();
    const result = await launcher.create('alice', { ...payload, provider: 'codex' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 400, code: 'invalid' });
    expect(result._unsafeUnwrapErr().message).toContain('Claude');
    expect(prepared).toEqual([]);
  });

  test('rejects a payload without a connection or a prompt', async () => {
    const { launcher } = setup();
    expect((await launcher.create('alice', { ...payload, sandbox: undefined })).isErr()).toBe(true);
    expect((await launcher.create('alice', { ...payload, prompt: '' })).isErr()).toBe(true);
  });

  test('a provisioning failure marks the thread failed and sends nothing', async () => {
    const { launcher, messages, failed, events } = setup({
      provisionError: { kind: 'checkout', message: 'clone failed' },
    });
    await (await launcher.create('alice', payload))._unsafeUnwrap().started;
    expect(messages).toEqual([]);
    expect(events).toEqual(['first-message:t-new']);
    expect(failed).toEqual([
      [
        't-new',
        {
          phase: 'setup',
          kind: 'checkout',
          message: 'clone failed',
          hint: expect.stringContaining('could not be cloned'),
        },
      ],
    ]);
  });

  test('a rejected first message marks the thread failed', async () => {
    const { launcher, failed } = setup({ messageFails: true });
    await (await launcher.create('alice', payload))._unsafeUnwrap().started;
    expect(failed).toEqual([
      [
        't-new',
        { phase: 'start', message: 'The agent could not be started: message failed (500)' },
      ],
    ]);
  });
});

describe('retrying a sandbox thread whose setup failed', () => {
  const failedThread: RetryableSandboxThread = {
    projectId: 'p1',
    runtime: 'sandbox',
    status: 'failed',
    sessionId: null,
    initialPrompt: 'Fix the login bug',
    createdAt: '2026-10-31T10:00:00.000Z',
  };
  const lastMachine = {
    connectionId: 'conn-1',
    sizeId: 'large',
    repoUrl: 'https://github.com/acme/app.git',
  };

  test('provisions the same machine again and sends the initial prompt plus the new message', async () => {
    const { launcher, prepared, messages, failed, events, recorded } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
    });
    const result = await launcher.retry('alice', 't-failed', {
      content: 'try again please',
      model: 'opus',
    });
    expectOkCreate(result);
    await result._unsafeUnwrap().started;

    expect(prepared).toEqual([
      {
        userId: 'alice',
        threadId: 't-failed',
        projectId: 'p1',
        projectPath: '/home/alice/app',
        connectionId: 'conn-1',
        sizeId: 'large',
        repoUrl: 'https://github.com/acme/app.git',
      },
    ]);
    // The agent sees both prompts, but only the new message is saved with it…
    expect(messages[0].body).toEqual({
      content: 'try again please',
      precedingPrompt: 'Fix the login bug',
      model: 'opus',
    });
    // …the initial prompt is its own message, dated when the thread was
    // created, so it reads before the failure card and the new message after.
    expect(recorded).toEqual([
      {
        userId: 'alice',
        threadId: 't-failed',
        content: 'Fix the login bug',
        timestamp: '2026-10-31T10:00:00.000Z',
      },
    ]);
    expect(failed).toEqual([]);
    expect(events).toEqual([
      'first-message:t-failed',
      'setting_up:t-failed',
      'ready:t-failed',
      'message:t-failed',
    ]);
  });

  test('a thread whose first message was saved at creation does not get it again', async () => {
    const { launcher, messages, recorded } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
      hasMessages: true,
    });
    await (await launcher.retry('alice', 't-failed', { content: 'hola' }))._unsafeUnwrap().started;
    expect(recorded).toEqual([]);
    expect(messages[0].body).toEqual({ content: 'hola', precedingPrompt: 'Fix the login bug' });
  });

  test("the agent also gets the initial prompt's images, which are not saved again", async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
    };
    const { launcher, messages } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
      hasMessages: true,
      firstImages: [image],
    });
    await (await launcher.retry('alice', 't-failed', { content: 'hola' }))._unsafeUnwrap().started;
    // `images` stays the new message's own (none here): the runner saves only those.
    expect(messages[0].body).toEqual({
      content: 'hola',
      precedingPrompt: 'Fix the login bug',
      precedingImages: [image],
    });
  });

  test('re-sending the initial prompt does not duplicate it', async () => {
    const { launcher, messages, recorded } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
    });
    await (
      await launcher.retry('alice', 't-failed', { content: 'Fix the login bug' })
    )._unsafeUnwrap().started;
    expect(messages[0].body).toEqual({ content: 'Fix the login bug' });
    expect(recorded).toEqual([]);
  });

  test("a retry checks out the thread's base branch again", async () => {
    const { launcher, prepared } = setup({
      thread: { ...failedThread, baseBranch: 'feature/login' },
      previousSandbox: lastMachine,
    });
    expectOkCreate(await launcher.retry('alice', 't-failed', { content: 'go' }));
    expect(prepared[0]).toMatchObject({ branch: 'feature/login' });
  });

  test('without a previous sandbox row it uses the project sandbox', async () => {
    const { launcher, prepared } = setup({
      thread: failedThread,
      projectSandbox: { connectionId: 'conn-instabox', sizeId: 'small' },
    });
    expectOkCreate(await launcher.retry('alice', 't-failed', { content: 'go' }));
    expect(prepared[0]).toMatchObject({ connectionId: 'conn-instabox', sizeId: 'small' });
  });

  test('a failed retry marks the thread failed again', async () => {
    const { launcher, failed } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
      provisionError: { kind: 'sandbox', message: 'exec timed out', cause: 'unavailable' },
    });
    await (await launcher.retry('alice', 't-failed', { content: 'go' }))._unsafeUnwrap().started;
    expect(failed[0]?.[0]).toBe('t-failed');
  });

  test('refuses threads that are not a failed, never-started sandbox', async () => {
    for (const thread of [
      { ...failedThread, status: 'completed' },
      { ...failedThread, sessionId: 'sess-1' },
      { ...failedThread, runtime: 'local' },
    ]) {
      const { launcher, prepared, events } = setup({ thread, previousSandbox: lastMachine });
      const result = await launcher.retry('alice', 't-failed', { content: 'go' });
      expect(result._unsafeUnwrapErr()).toMatchObject({
        status: 409,
        code: 'sandbox-not-retryable',
      });
      expect(prepared).toEqual([]);
      expect(events).toEqual([]);
    }
  });

  test("another user's thread is not found", async () => {
    const { launcher, prepared } = setup({ thread: failedThread, previousSandbox: lastMachine });
    const result = await launcher.retry('mallory', 't-failed', { content: 'go' });
    expect(result._unsafeUnwrapErr().status).toBe(404);
    expect(prepared).toEqual([]);
  });

  test('a refused launch leaves the thread failed', async () => {
    const { launcher, events } = setup({
      thread: failedThread,
      previousSandbox: lastMachine,
      refusal: { code: 'repo-url-unknown', message: 'no repo' },
    });
    const result = await launcher.retry('alice', 't-failed', { content: 'go' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 409, code: 'repo-url-unknown' });
    expect(events).toEqual([]);
  });

  test('an empty message is rejected', async () => {
    const { launcher } = setup({ thread: failedThread, previousSandbox: lastMachine });
    const result = await launcher.retry('alice', 't-failed', { content: '' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 400, code: 'invalid' });
  });
});

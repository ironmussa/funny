import { describe, expect, test } from 'bun:test';

import { err, errAsync, ok, okAsync } from 'neverthrow';

import type { SandboxLaunchRequest } from '../../../services/thread-sandboxes/sandbox-launch.js';
import {
  createSandboxThreadLauncher,
  type NewSandboxThreadRow,
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
  } = {},
) {
  const inserted: NewSandboxThreadRow[] = [];
  const prepared: SandboxLaunchRequest[] = [];
  const messages: Array<{ userId: string; threadId: string; body: Record<string, unknown> }> = [];
  const failed: Array<[string, string]> = [];
  const events: string[] = [];
  const launcher = createSandboxThreadLauncher({
    findOwnedProject: async (userId, projectId) =>
      opts.project !== undefined
        ? opts.project
        : userId === 'alice' && projectId === 'p1'
          ? { path: '/home/alice/app' }
          : null,
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
  return { launcher, inserted, prepared, messages, failed, events };
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
        },
      },
    ]);
    expect(failed).toEqual([]);
    // The agent can only start from `pending`: the thread leaves setting_up first.
    expect(events).toEqual(['ready:t-new', 'message:t-new']);
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
    expect(events).toEqual([]);
    expect(failed).toEqual([['t-new', 'sandbox provisioning failed: clone failed']]);
  });

  test('a rejected first message marks the thread failed', async () => {
    const { launcher, failed } = setup({ messageFails: true });
    await (await launcher.create('alice', payload))._unsafeUnwrap().started;
    expect(failed).toEqual([['t-new', 'message failed (500)']]);
  });
});

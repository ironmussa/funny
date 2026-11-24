/**
 * The `profile` tRPC router over the server port (openspec `thread-recap`,
 * task 1.3): the utility model and the recap toggle are saved and read back,
 * default to recaps on with the default model, and an invalid utility model is
 * refused with 400 without changing what was stored.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { appRouter, type ApiPorts } from '@funny/api';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { profilePort } from '../../trpc/ports/profile.js';

const profileOnly = { profile: profilePort };
// SAFETY: this suite only calls `profile.*` procedures, which reach no other port.
const ports = profileOnly as ApiPorts;
const context = (userId: string) => ({
  userId,
  organizationId: null,
  userRole: 'user' as const,
  ports,
});
const caller = (userId = 'alice') => appRouter.createCaller(context(userId));

/** POST `profile.update` over HTTP, so the status the browser sees is checked. */
async function postUpdate(userId: string, input: unknown) {
  const res = await fetchRequestHandler({
    endpoint: '/api/trpc',
    router: appRouter,
    req: new Request('http://x/api/trpc/profile.update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    createContext: () => context(userId),
  });
  return res.status;
}

describe('profile router: utility model and thread recap', () => {
  let db: (typeof import('../../db/index.js'))['db'];

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(() => {
    db.run('DELETE FROM user_profiles');
  });

  test('a user with no profile row reads recaps on and the default model', async () => {
    const profile = await caller().profile.get();
    expect(profile.threadRecapEnabled).toBe(true);
    expect(profile.utilityModel).toBeNull();
  });

  test('an existing row saved without the new fields reads the defaults', async () => {
    await caller().profile.update({ gitName: 'Alice' });
    const profile = await caller().profile.get();
    expect(profile.gitName).toBe('Alice');
    expect(profile.threadRecapEnabled).toBe(true);
    expect(profile.utilityModel).toBeNull();
  });

  test('saving both on the first write (insert) reads them back', async () => {
    const saved = await caller().profile.update({
      utilityModel: { provider: 'openai', model: 'gpt-4o' },
      threadRecapEnabled: false,
    });
    expect(saved.utilityModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(saved.threadRecapEnabled).toBe(false);

    const profile = await caller().profile.get();
    expect(profile.utilityModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(profile.threadRecapEnabled).toBe(false);
  });

  test('saving on an existing row (update) reads them back, and null clears the model', async () => {
    await caller().profile.update({ gitName: 'Alice' });
    await caller().profile.update({
      utilityModel: {
        provider: 'openai-compatible',
        model: 'qwen',
        baseURL: 'http://localhost:8000/v1',
      },
      threadRecapEnabled: false,
    });
    let profile = await caller().profile.get();
    expect(profile.utilityModel).toEqual({
      provider: 'openai-compatible',
      model: 'qwen',
      baseURL: 'http://localhost:8000/v1',
    });
    expect(profile.threadRecapEnabled).toBe(false);

    await caller().profile.update({ utilityModel: null, threadRecapEnabled: true });
    profile = await caller().profile.get();
    expect(profile.utilityModel).toBeNull();
    expect(profile.threadRecapEnabled).toBe(true);
    expect(profile.gitName).toBe('Alice');
  });

  test('an invalid utility model is refused with 400 and the stored value is kept', async () => {
    await caller().profile.update({ utilityModel: { provider: 'anthropic', model: 'claude' } });

    expect(
      await postUpdate('alice', { utilityModel: { provider: 'openai-compatible', model: 'm' } }),
    ).toBe(400);
    expect(await postUpdate('alice', { utilityModel: { provider: 'gemini', model: 'x' } })).toBe(
      400,
    );
    await expect(
      caller().profile.update({
        utilityModel: { provider: 'openai-compatible', model: 'm' },
        threadRecapEnabled: false,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const profile = await caller().profile.get();
    expect(profile.utilityModel).toEqual({ provider: 'anthropic', model: 'claude' });
    expect(profile.threadRecapEnabled).toBe(true);
  });

  test('a stored value the schema refuses reads as the default', async () => {
    await caller().profile.update({ gitName: 'Alice' });
    db.run(
      `UPDATE user_profiles SET utility_model = '{"provider":"gemini","model":"x"}' WHERE user_id = 'alice'`,
    );
    expect((await caller().profile.get()).utilityModel).toBeNull();
  });
});

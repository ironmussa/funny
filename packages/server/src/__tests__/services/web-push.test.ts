import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import webpush from 'web-push';

import { createTestDb, seedThread } from '../helpers/test-db.js';

const { sqlite, db } = createTestDb();
sqlite.exec(
  'CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL)',
);
mock.module('../../db/index.js', () => ({
  db,
  dbAll: async (q: any) => q.all(),
  dbRun: async (q: any) => q.run(),
  dbGet: async (q: any) => q.get(),
}));
const { pushRoutes } = await import('../../routes/push.js');
const { isPushEndpoint, saveSubscription, sendPush, removeSubscription, pushAgentResult } =
  await import('../../services/web-push.js');
const { Hono } = await import('hono');
const app = new Hono<any>();
app.use('*', async (c, next) => {
  c.set('userId', 'alice');
  await next();
});
app.route('/push', pushRoutes);
const input = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device',
  keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
};
const payload = { title: 'funny', body: 'Finished', url: '/', tag: 'test' };
const originalEnv = {
  public: process.env.WEB_PUSH_PUBLIC_KEY,
  private: process.env.WEB_PUSH_PRIVATE_KEY,
  subject: process.env.WEB_PUSH_SUBJECT,
};
beforeEach(() => {
  sqlite.exec('DELETE FROM push_subscriptions; DELETE FROM threads');
  process.env.WEB_PUSH_PUBLIC_KEY = 'public';
  process.env.WEB_PUSH_PRIVATE_KEY = 'private';
  process.env.WEB_PUSH_SUBJECT = 'mailto:test@example.com';
});
afterEach(() => {
  mock.restore();
  for (const [key, value] of Object.entries({
    WEB_PUSH_PUBLIC_KEY: originalEnv.public,
    WEB_PUSH_PRIVATE_KEY: originalEnv.private,
    WEB_PUSH_SUBJECT: originalEnv.subject,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe('Web Push', () => {
  test('rejects arbitrary outbound destinations and malformed subscriptions', async () => {
    for (const url of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://user@web.push.apple.com/x',
    ])
      expect(isPushEndpoint(url)).toBe(false);
    const response = await app.request('/push/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, endpoint: 'https://localhost/x' }),
    });
    expect(response.status).toBe(400);
  });
  test('sends only to the authenticated user and prevents another user deleting it', async () => {
    const send = spyOn(webpush, 'sendNotification').mockResolvedValue({
      statusCode: 201,
      body: '',
      headers: {},
    });
    await saveSubscription('alice', input);
    await removeSubscription('bob', input.endpoint);
    expect(await sendPush('bob', payload)).toBe(0);
    expect(await sendPush('alice', payload)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(JSON.stringify(payload));
  });
  test('removes expired subscriptions but retains transient failures', async () => {
    const send = spyOn(webpush, 'sendNotification').mockRejectedValue({ statusCode: 503 });
    await saveSubscription('alice', input);
    expect(await sendPush('alice', payload)).toBe(0);
    expect(sqlite.query('SELECT * FROM push_subscriptions').all()).toHaveLength(1);
    send.mockRejectedValue({ statusCode: 410 });
    await sendPush('alice', payload);
    expect(sqlite.query('SELECT * FROM push_subscriptions').all()).toHaveLength(0);
  });
  test('reports unavailable configuration instead of pretending to subscribe', async () => {
    delete process.env.WEB_PUSH_PRIVATE_KEY;
    const response = await app.request('/push/subscription', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(503);
    expect(await (await app.request('/push/config')).json()).toEqual({ publicKey: null });
  });
});

test('completed scratch threads send without connected browsers; other users and stopped runs do not', async () => {
  const send = spyOn(webpush, 'sendNotification').mockResolvedValue({
    statusCode: 201,
    body: '',
    headers: {},
  });
  seedThread(db, { id: 'scratch-1', projectId: null, isScratch: 1, userId: 'alice' });
  await saveSubscription('alice', input);
  const event = { type: 'agent:result', threadId: 'scratch-1', data: { status: 'completed' } };
  await pushAgentResult('bob', event);
  await pushAgentResult('alice', { ...event, data: { status: 'stopped' } });
  expect(send).not.toHaveBeenCalled();
  await pushAgentResult('alice', event);
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1] as string)).toMatchObject({
    url: '/scratch/scratch-1',
    body: 'Agent finished',
  });
});

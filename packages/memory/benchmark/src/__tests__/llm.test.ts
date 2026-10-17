import { afterEach, expect, it, vi } from 'vitest';

import { createConfig, llmChat } from '../config.js';

afterEach(() => vi.unstubAllGlobals());
it('uses Chat Completions for localhost, preserving messages and authentication', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'answer' } }], usage: { total_tokens: 7 } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const messages = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'question' },
  ];
  expect(
    await llmChat(
      createConfig({ apiBaseUrl: 'http://localhost:8317/v1/', apiKey: 'key' }),
      messages,
    ),
  ).toEqual({ content: 'answer', tokensUsed: 7 });
  expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8317/v1/chat/completions');
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer key');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual(messages);
});

import { describe, expect, test } from 'vitest';

import { llmProxyEnv } from '../../services/agent-startup/agent-env.js';

const sandboxEnv = {
  FUNNY_LLM_PROXY_TOKEN: 'llmp_abc',
  TEAM_SERVER_URL: 'https://funny.example/',
};

describe('llmProxyEnv (thread-sandboxes)', () => {
  test('a Claude agent on a sandbox runner calls Anthropic through the server proxy', () => {
    expect(llmProxyEnv('claude', sandboxEnv)).toEqual({
      ANTHROPIC_BASE_URL: 'https://funny.example/api/llm-proxy/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'llmp_abc',
    });
  });

  test('other providers never receive the proxy token', () => {
    expect(llmProxyEnv('codex', sandboxEnv)).toEqual({});
  });

  test('a normal runner (no proxy token) keeps its own Claude login', () => {
    expect(llmProxyEnv('claude', { TEAM_SERVER_URL: 'https://funny.example' })).toEqual({});
  });
});

/**
 * The utility model setting (openspec `thread-recap`, task 1.1): the schema
 * the profile stores and the default a helper generation falls back to.
 */
import { describe, expect, test } from 'bun:test';

import {
  UtilityModelSetting,
  resolveUtilityModel,
  updateProfileBody,
} from '../contracts/profile.js';

describe('resolveUtilityModel', () => {
  test('no setting resolves to Claude Haiku', () => {
    expect(resolveUtilityModel(null)).toEqual({ provider: 'claude', model: 'haiku' });
  });

  test('a valid setting is returned unchanged', () => {
    const setting = UtilityModelSetting.parse({ provider: 'openai', model: 'gpt-4o' });
    expect(setting).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(resolveUtilityModel(setting)).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
});

describe('UtilityModelSetting', () => {
  test('agent providers with optional effort and legacy claude-sdk are accepted', () => {
    for (const value of [
      { provider: 'claude', model: 'haiku', effort: 'low' },
      { provider: 'codex', model: 'o4-mini', effort: 'high' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'claude-sdk', model: 'haiku' },
    ]) {
      expect(UtilityModelSetting.safeParse(value).success).toBe(true);
    }
  });

  test('openai-compatible without a base URL is refused', () => {
    const res = UtilityModelSetting.safeParse({ provider: 'openai-compatible', model: 'llama3' });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['baseURL']);
  });

  test('openai-compatible with a base URL, and ollama with or without one, are accepted', () => {
    for (const value of [
      { provider: 'openai-compatible', model: 'm', baseURL: 'http://localhost:8000/v1' },
      { provider: 'ollama', model: 'llama3', baseURL: 'http://localhost:11434/v1' },
      { provider: 'ollama', model: 'llama3' },
    ]) {
      expect(UtilityModelSetting.safeParse(value).success).toBe(true);
    }
  });

  test('an unknown provider, an empty model or a base URL a provider does not use is refused', () => {
    for (const value of [
      { provider: 'unknown-provider', model: 'x' },
      { provider: 'anthropic', model: '' },
      { provider: 'openai', model: 'gpt-4o', baseURL: 'http://evil.example' },
      { provider: 'claude', model: 'haiku', baseURL: 'http://evil.example' },
    ]) {
      expect(UtilityModelSetting.safeParse(value).success).toBe(false);
    }
  });

  test('the profile update body accepts a setting, null and the recap toggle', () => {
    expect(updateProfileBody.parse({ utilityModel: null, threadRecapEnabled: false })).toEqual({
      utilityModel: null,
      threadRecapEnabled: false,
    });
    expect(
      updateProfileBody.safeParse({ utilityModel: { provider: 'openai-compatible', model: 'm' } })
        .success,
    ).toBe(false);
  });
});

/**
 * The utility model setting (openspec thread-recap, task 1.1): the default for
 * a user who never chose one, a valid setting, and the base URL an
 * `openai-compatible` endpoint needs.
 */
import { describe, expect, test } from 'bun:test';

import { resolveUtilityModel, UtilityModelSetting } from '../contracts/profile.js';

describe('UtilityModelSetting', () => {
  test('no setting resolves to Claude Haiku through the Agent SDK', () => {
    expect(resolveUtilityModel(null)).toEqual({ provider: 'claude-sdk', model: 'haiku' });
  });

  test('a saved setting resolves to itself', () => {
    const setting = UtilityModelSetting.parse({ provider: 'openai', model: 'gpt-4o' });
    expect(setting).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(resolveUtilityModel(setting)).toEqual(setting);
  });

  test('openai-compatible needs a base URL', () => {
    const missing = UtilityModelSetting.safeParse({ provider: 'openai-compatible', model: 'm' });
    expect(missing.success).toBe(false);
    expect(
      UtilityModelSetting.safeParse({
        provider: 'openai-compatible',
        model: 'm',
        baseURL: 'http://localhost:8000/v1',
      }).success,
    ).toBe(true);
  });

  test('ollama works with or without a base URL', () => {
    expect(UtilityModelSetting.safeParse({ provider: 'ollama', model: 'llama3' }).success).toBe(
      true,
    );
    expect(
      UtilityModelSetting.safeParse({
        provider: 'ollama',
        model: 'llama3',
        baseURL: 'http://localhost:11434',
      }).success,
    ).toBe(true);
  });

  test('an unknown provider or an empty model is refused', () => {
    expect(UtilityModelSetting.safeParse({ provider: 'gemini', model: 'x' }).success).toBe(false);
    expect(UtilityModelSetting.safeParse({ provider: 'openai', model: '' }).success).toBe(false);
  });
});

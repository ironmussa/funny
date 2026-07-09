import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { parseExternalPayload, parseStoredJson } from '../json-validation';

const profileSchema = z.object({
  providerKeys: z.record(z.string(), z.string()),
});

describe('json-validation', () => {
  test('parseStoredJson parses and validates persisted JSON text', () => {
    expect(
      parseStoredJson(
        profileSchema,
        '{"providerKeys":{"github":"cipher"}}',
        'profile.providerKeys',
      ),
    ).toEqual({
      ok: true,
      value: { providerKeys: { github: 'cipher' } },
    });

    const invalidJson = parseStoredJson(profileSchema, '{', 'profile.providerKeys');
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error).toContain('invalid JSON');

    const invalidShape = parseStoredJson(profileSchema, '{"providerKeys":{"github":42}}');
    expect(invalidShape.ok).toBe(false);
    if (!invalidShape.ok)
      expect(invalidShape.issues[0]).toMatchObject({
        path: 'providerKeys.github',
      });
  });

  test('parseExternalPayload validates already-decoded provider payloads', () => {
    const schema = z.object({ token: z.string().min(1) });
    expect(parseExternalPayload(schema, { token: 'abc' }, 'assemblyai token')).toEqual({
      ok: true,
      value: { token: 'abc' },
    });

    const result = parseExternalPayload(schema, { token: '' }, 'assemblyai token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('assemblyai token');
  });
});

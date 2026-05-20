import { describe, test, expect } from 'vitest';

import { buildSendMessagePayload, type SendMessageOpts } from '../send-message-payload';

const baseOpts: SendMessageOpts = { model: 'sonnet', mode: 'autoEdit' };

describe('buildSendMessagePayload', () => {
  test('maps PromptInput `mode` to API `permissionMode`', () => {
    const payload = buildSendMessagePayload(baseOpts, {});
    expect(payload.permissionMode).toBe('autoEdit');
    expect((payload as any).mode).toBeUndefined();
  });

  test('derives allowedTools / disallowedTools from toolPermissions', () => {
    const payload = buildSendMessagePayload(baseOpts, {
      Bash: 'allow',
      WebFetch: 'deny',
      Read: 'ask',
    });
    expect(payload.allowedTools).toEqual(['Bash']);
    expect(payload.disallowedTools).toEqual(['WebFetch']);
  });

  test('includes effort by default', () => {
    const payload = buildSendMessagePayload({ ...baseOpts, effort: 'high' }, {});
    expect(payload.effort).toBe('high');
  });

  test('omits effort field when includeEffort: false (follow-up dialog path)', () => {
    const payload = buildSendMessagePayload(
      { ...baseOpts, effort: 'high' },
      {},
      { includeEffort: false },
    );
    expect('effort' in payload).toBe(false);
  });

  test('coerces empty string fields to undefined (provider, model, mode)', () => {
    const payload = buildSendMessagePayload({ provider: '', model: '', mode: '', effort: '' }, {});
    expect(payload.provider).toBeUndefined();
    expect(payload.model).toBeUndefined();
    expect(payload.permissionMode).toBeUndefined();
    expect(payload.effort).toBeUndefined();
  });

  test('forwards fileReferences and symbolReferences', () => {
    const payload = buildSendMessagePayload(
      {
        ...baseOpts,
        fileReferences: [{ path: 'src/foo.ts' }],
        symbolReferences: [{ path: 'src/foo.ts', name: 'bar', kind: 'function', line: 12 }],
      },
      {},
    );
    expect(payload.fileReferences).toEqual([{ path: 'src/foo.ts' }]);
    expect(payload.symbolReferences?.[0]?.name).toBe('bar');
  });
});

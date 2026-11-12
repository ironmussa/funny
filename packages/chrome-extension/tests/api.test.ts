import { describe, expect, test } from 'bun:test';

import {
  ApiError,
  IMAGE_MAX_BYTES,
  INVALID_TOKEN_MESSAGE,
  MISSING_TOKEN_MESSAGE,
  apiErrorFromResponse,
  buildApiRequest,
  buildCreateThreadBody,
  connectionFailure,
  dataUrlToImage,
  hasProjectDefaults,
  hostPermissionFor,
  isOversizedImage,
  isPermissionError,
  resolveConnection,
  threadUrl,
  toProviderMap,
  toPublicPermissionMode,
} from '../src/api';

const connection = { serverUrl: 'https://funny.example.com/', apiToken: ' funny_pat_abc ' };

describe('buildApiRequest', () => {
  test('calls /api/v1 with the bearer token', () => {
    const { url, init } = buildApiRequest(connection, '/projects');
    expect(url).toBe('https://funny.example.com/api/v1/projects');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer funny_pat_abc');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  test('sends a JSON body', () => {
    const { init } = buildApiRequest(connection, 'threads', { method: 'POST', body: { a: 1 } });
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('refuses to call without a token', () => {
    expect(() => buildApiRequest({ ...connection, apiToken: '  ' }, '/projects')).toThrow(
      MISSING_TOKEN_MESSAGE,
    );
  });
});

describe('apiErrorFromResponse', () => {
  test('401 means a bad token', () => {
    const error = apiErrorFromResponse(401, '{"message":"Unauthorized","code":"UNAUTHORIZED"}');
    expect(error.message).toBe(INVALID_TOKEN_MESSAGE);
    expect(error.reason).toBe('bad-token');
  });

  test('reads the trpc-to-openapi message and first issue', () => {
    const body = JSON.stringify({
      message: 'Input validation failed',
      code: 'BAD_REQUEST',
      issues: [{ message: 'Image larger than 5 MB', path: ['images', 0, 'data'] }],
    });
    const error = apiErrorFromResponse(400, body);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Input validation failed (images.0.data: Image larger than 5 MB)');
    expect(error.status).toBe(400);
  });

  test('falls back to the status when the body is not JSON', () => {
    expect(apiErrorFromResponse(502, '<html>').message).toBe('Request failed (502)');
    expect(apiErrorFromResponse(404, '').message).toContain('no public API v1');
  });
});

describe('toPublicPermissionMode', () => {
  test('keeps the modes the API accepts', () => {
    expect(toPublicPermissionMode('ask')).toBe('ask');
    expect(toPublicPermissionMode('confirmEdit')).toBe('confirmEdit');
    expect(toPublicPermissionMode('plan')).toBe('plan');
  });

  test('drops the modes that act without asking', () => {
    for (const mode of ['autoEdit', 'auto', 'bypassPermissions', '', undefined]) {
      expect(toPublicPermissionMode(mode)).toBeUndefined();
    }
  });
});

describe('buildCreateThreadBody', () => {
  const config = {
    projectId: 'p1',
    provider: 'claude',
    model: 'sonnet',
    permissionMode: 'autoEdit',
    mode: 'worktree',
  };
  const data = {
    markdown: '## Fix the button',
    screenshot: 'data:image/png;base64,iVBORw0KGgo=',
    annotations: [{ prompt: 'Make it blue' }],
    title: 'Home',
  };

  test('maps the annotations to the v1 body', () => {
    expect(buildCreateThreadBody(config, data)).toEqual({
      projectId: 'p1',
      prompt: '## Fix the button',
      title: 'Make it blue — Home',
      client: 'chrome_extension',
      mode: 'worktree',
      provider: 'claude',
      model: 'sonnet',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
  });

  test('sends an accepted permission mode', () => {
    const body = buildCreateThreadBody({ ...config, permissionMode: 'plan' }, data);
    expect(body.permissionMode).toBe('plan');
  });

  test('omits empty provider, model and screenshot', () => {
    const body = buildCreateThreadBody(
      { ...config, provider: '', model: '' },
      { markdown: 'x', url: 'https://a.test' },
    );
    expect(body).toEqual({
      projectId: 'p1',
      prompt: 'x',
      title: 'UI Review: https://a.test',
      client: 'chrome_extension',
      mode: 'worktree',
    });
  });

  test('uses the re-encoded screenshot when given', () => {
    const body = buildCreateThreadBody(config, data, 'data:image/jpeg;base64,/9j/4A==');
    expect(body.images).toEqual([{ mediaType: 'image/jpeg', data: '/9j/4A==' }]);
  });

  test('needs a project', () => {
    expect(() => buildCreateThreadBody({ ...config, projectId: '' }, data)).toThrow(
      'No project selected',
    );
  });
});

describe('dataUrlToImage', () => {
  test('rejects what the API does not accept', () => {
    expect(dataUrlToImage('data:image/gif;base64,R0lG')).toBeNull();
    expect(dataUrlToImage('not a data url')).toBeNull();
    expect(dataUrlToImage(undefined)).toBeNull();
  });
});

describe('hostPermissionFor', () => {
  test('localhost:3001 is covered by the manifest', () => {
    expect(hostPermissionFor('http://localhost:3001/')).toBeNull();
    expect(hostPermissionFor('http://127.0.0.1:3001')).toBeNull();
  });

  test('other servers need their origin', () => {
    expect(hostPermissionFor('https://funny.example.com/app/')).toBe('https://funny.example.com/*');
    expect(hostPermissionFor('http://localhost:8080')).toBe('http://localhost:8080/*');
    expect(hostPermissionFor('ftp://x')).toBeNull();
  });
});

describe('threadUrl', () => {
  test('links to the thread route', () => {
    expect(threadUrl('https://funny.example.com/', { id: 't1', projectId: 'p1' })).toBe(
      'https://funny.example.com/projects/p1/threads/t1',
    );
  });
});

describe('settings helpers', () => {
  test('a large screenshot is oversized, a small one is not', () => {
    const big = `data:image/png;base64,${'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 3) / 3) * 4)}`;
    expect(isOversizedImage(big)).toBe(true);
    expect(isOversizedImage('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isOversizedImage(undefined)).toBe(false);
  });

  test('the entered connection wins over the saved one, an empty URL does not', () => {
    const saved = { serverUrl: 'http://localhost:3001', apiToken: 'saved' };
    expect(resolveConnection(saved, 'https://x.test', 'typed')).toEqual({
      serverUrl: 'https://x.test',
      apiToken: 'typed',
    });
    expect(resolveConnection(saved, '', undefined)).toEqual(saved);
    expect(resolveConnection(saved, undefined, '')).toEqual({ ...saved, apiToken: '' });
  });

  test('failures keep their reason', () => {
    expect(connectionFailure(new ApiError(INVALID_TOKEN_MESSAGE, 'bad-token', 401))).toEqual({
      success: false,
      reason: 'bad-token',
      error: INVALID_TOKEN_MESSAGE,
    });
    expect(connectionFailure(new TypeError('Failed to fetch'))).toEqual({
      success: false,
      reason: 'unreachable',
      error: 'Failed to fetch',
    });
    expect(isPermissionError({ reason: 'permission' })).toBe(true);
    expect(isPermissionError({ reason: 'bad-token' })).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });

  test('projects from the public API have no defaults', () => {
    expect(hasProjectDefaults({ id: 'p1' } as { defaultMode?: string })).toBe(false);
    expect(hasProjectDefaults({ defaultMode: 'local' })).toBe(true);
    expect(hasProjectDefaults(undefined)).toBe(false);
  });
});

describe('toProviderMap', () => {
  test('maps the v1 model list, default provider first', () => {
    const map = toProviderMap({
      defaultProvider: 'claude',
      providers: [
        { id: 'codex', name: 'Codex', defaultModel: 'o3', models: [{ id: 'o3', name: 'o3' }] },
        {
          id: 'claude',
          name: 'Claude',
          defaultModel: 'sonnet',
          models: [{ id: 'sonnet', name: 'Sonnet' }],
        },
      ],
    });
    expect(Object.keys(map)).toEqual(['claude', 'codex']);
    expect(map.claude).toEqual({
      available: true,
      label: 'Claude',
      defaultModel: 'sonnet',
      modelsWithLabels: [{ value: 'sonnet', label: 'Sonnet' }],
    });
  });

  test('an empty or missing list gives no providers', () => {
    expect(toProviderMap(null)).toEqual({});
  });
});

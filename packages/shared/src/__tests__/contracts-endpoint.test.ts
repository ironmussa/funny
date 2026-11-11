import { describe, test, expect } from 'bun:test';

import { z } from 'zod';

import { endpointGroup, endpointPath, endpointQuery } from '../contracts/endpoint';

const api = endpointGroup('/things');

describe('endpointPath', () => {
  test('the group root is the base without a trailing slash', () => {
    const list = api.endpoint<string[]>()({ method: 'GET', path: '/' });
    expect(endpointPath(list)).toBe('/things');
  });

  test('fills every path param and encodes it', () => {
    const triage = api.endpoint<void>()({ method: 'PATCH', path: '/:id/runs/:runId' });
    expect(endpointPath(triage, { id: 'a/b', runId: 'r 1' })).toBe('/things/a%2Fb/runs/r%201');
  });

  test('refuses a missing param instead of sending ":id"', () => {
    const get = api.endpoint<string>()({ method: 'GET', path: '/:id' });
    expect(() => endpointPath(get, {})).toThrow('Missing path param "id"');
  });
});

describe('endpointQuery', () => {
  test('drops undefined and null values', () => {
    expect(endpointQuery(undefined)).toBe('');
    expect(endpointQuery({ projectId: undefined, status: null })).toBe('');
    expect(endpointQuery({ projectId: 'p1', triageStatus: undefined })).toBe('?projectId=p1');
  });

  test('repeats array values and encodes them', () => {
    expect(endpointQuery({ tag: ['a b', 'c&d'] })).toBe('?tag=a+b&tag=c%26d');
  });
});

describe('endpointGroup', () => {
  test('keeps the schemas on the endpoint for the server to validate with', () => {
    const body = z.object({ name: z.string() });
    const create = api.endpoint<string>()({ method: 'POST', path: '/', body });
    expect(create).toMatchObject({ method: 'POST', base: '/things', path: '/', body });
    expect(create.query).toBeUndefined();
  });
});

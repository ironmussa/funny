import { describe, expect, test } from 'bun:test';

import {
  BROWSER_PTY_FORWARD_EVENTS,
  RUNNER_DATA_EVENTS,
  browserPtyForwardPayloadSchema,
  parseSocketPayload,
  parseCentralCommand,
  parseDataResponse,
  parseObjectPayload,
  parseRunnerAgentEvent,
  parseRunnerDataRequest,
  parseTunnelRequest,
  runnerAssignProjectSchema,
  runnerHeartbeatSchema,
  runnerAgentEventSchema,
} from '../socket-events';

describe('socket-events', () => {
  test('parseObjectPayload accepts objects and nullish', () => {
    expect(parseObjectPayload(null)).toEqual({});
    expect(parseObjectPayload({ projectId: 'p1' })).toEqual({
      projectId: 'p1',
    });
    expect(parseObjectPayload([])).toBeNull();
    expect(parseObjectPayload('x')).toBeNull();
  });

  test('parseRunnerAgentEvent validates userId', () => {
    expect(parseRunnerAgentEvent({ userId: 'u1', event: { type: 'agent:status' } })).toEqual({
      userId: 'u1',
      event: { type: 'agent:status' },
    });
    expect(parseRunnerAgentEvent({ event: {} })).toBeNull();
  });

  test('BROWSER_PTY_FORWARD_EVENTS includes pty:signal', () => {
    expect(BROWSER_PTY_FORWARD_EVENTS).toContain('pty:signal');
  });

  test('RUNNER_DATA_EVENTS includes thread lookup queries', () => {
    expect(RUNNER_DATA_EVENTS).toContain('data:get_thread_by_external_request_id');
    expect(RUNNER_DATA_EVENTS).toContain('data:get_thread_by_session_id');
  });

  test('runnerAgentEventSchema rejects arrays', () => {
    expect(runnerAgentEventSchema.safeParse([]).success).toBe(false);
  });

  test('parseTunnelRequest validates tunnel request shape', () => {
    expect(
      parseTunnelRequest({
        method: 'POST',
        path: '/api/test',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/test',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(parseTunnelRequest({ method: 'GET', path: '/api/test', headers: {} })).toBeNull();
  });

  test('parseDataResponse and parseRunnerDataRequest enforce request ids', () => {
    expect(parseDataResponse({ requestId: 'abc_123', response: { ok: true } })).toEqual({
      requestId: 'abc_123',
      response: { ok: true },
    });
    expect(parseDataResponse({ requestId: 'bad id' })).toBeNull();

    expect(parseRunnerDataRequest({ _requestId: 'abc-123', payload: { id: 'm1' } })).toEqual({
      _requestId: 'abc-123',
      payload: { id: 'm1' },
    });
    expect(parseRunnerDataRequest({ _requestId: '../bad' })).toBeNull();
  });

  test('parseCentralCommand accepts optional task envelope', () => {
    expect(parseCentralCommand({ task: { taskId: 't1', type: 'run', extra: true } })).toEqual({
      task: { taskId: 't1', type: 'run', extra: true },
    });
    expect(parseCentralCommand('bad')).toBeNull();
  });

  test('parseSocketPayload applies per-event schemas', () => {
    expect(
      parseSocketPayload(browserPtyForwardPayloadSchema, {
        projectId: 'p1',
        id: 'pty1',
      }),
    ).toEqual({
      projectId: 'p1',
      id: 'pty1',
    });
    expect(parseSocketPayload(browserPtyForwardPayloadSchema, { projectId: 42 })).toBeNull();
  });

  test('runner control schemas normalize compatible payloads', () => {
    expect(parseSocketPayload(runnerHeartbeatSchema, undefined)).toEqual({
      activeThreadIds: [],
    });
    expect(
      parseSocketPayload(runnerAssignProjectSchema, {
        payload: { projectId: 'p1', localPath: '/tmp/project' },
      }),
    ).toEqual({ projectId: 'p1', localPath: '/tmp/project' });
    expect(parseSocketPayload(runnerAssignProjectSchema, { projectId: 'p1' })).toBeNull();
  });
});

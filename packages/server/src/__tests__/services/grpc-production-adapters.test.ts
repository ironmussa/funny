import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FailureCode } from '@funny/shared/runner-v2/common';
import { GrpcEventReplayStore } from '@ironmussa/funny-runtime/services/grpc-event-replay-store';
import { GrpcOperationOutbox } from '@ironmussa/funny-runtime/services/grpc-operation-outbox';
import { GrpcTeamTransport } from '@ironmussa/funny-runtime/services/grpc-team-transport';
import { GrpcTerminalReplayStore } from '@ironmussa/funny-runtime/services/grpc-terminal-replay-store';

import { RunnerRequestTimeoutError } from '../../services/runner-ports.js';
import { SocketIoBrowserEventSink } from '../../services/socketio/browser-event-sink.js';
import { setupBrowserPtyHandlers } from '../../services/socketio/browser-pty.js';
import { setupBrowserSessionHandlers } from '../../services/socketio/browser-session.js';
import {
  createProductionGrpcFixture,
  MemoryOperationIdempotency,
  type ProductionGrpcFixture,
  waitFor,
} from '../helpers/runner-grpc-production-fixture.js';
import { createMockIo, createMockSocket } from '../helpers/socketio-test-mocks.js';

let fixture: ProductionGrpcFixture | null = null;

afterEach(async () => {
  await fixture?.shutdown();
  fixture = null;
  delete process.env.RUNNER_AUTH_SECRET;
});

describe('production TypeScript runner gRPC adapters', () => {
  test('carries browser Socket.IO PTY and browser-session commands through real gRPC adapters', async () => {
    process.env.RUNNER_AUTH_SECRET = 'vertical-secret';
    const { io, capture } = createMockIo();
    const browserEvents = new SocketIoBrowserEventSink(io);
    const tunnelRequests: Array<{ url: string; body: string; forwardedUser: string | null }> = [];
    fixture = await createProductionGrpcFixture({
      browserEvents,
      handleTunnel: async (request) => {
        tunnelRequests.push({
          url: request.url,
          body: await request.text(),
          forwardedUser: request.headers.get('x-forwarded-user'),
        });
        return new Response('', { status: 202 });
      },
    });
    const socket = createMockSocket();
    const dependencies = {
      terminals: fixture.endpoint.terminals,
      requests: fixture.endpoint.requests,
      findAnyRunnerForUser: async () => 'runner-1',
      findRunnerForProject: async () => 'runner-1',
      getRunnerUserId: async () => 'user-1',
      getProjectOwnerId: async () => 'user-1',
    };
    setupBrowserPtyHandlers(socket, 'user-1', dependencies);
    setupBrowserSessionHandlers(socket, 'user-1', dependencies);

    await socket.trigger('pty:spawn', { projectId: 'project-1', id: 'pty-1' });
    await socket.trigger('pty:write', { projectId: 'project-1', id: 'pty-1', data: 'pwd\n' });
    await waitFor(
      () => capture.userRoomEmits.some(({ event }) => event === 'pty:data'),
      'terminal response did not reach the browser room',
    );
    expect(capture.userRoomEmits).toContainEqual({
      room: 'user:user-1',
      event: 'pty:data',
      payload: expect.objectContaining({ data: { ptyId: 'pty-1', data: 'terminal-ok' } }),
    });

    await socket.trigger('browser-session:navigate', {
      sessionId: 'session-1',
      url: 'https://example.com',
    });
    await waitFor(
      () => tunnelRequests.length === 1,
      'browser-session command did not reach runner',
    );
    expect(tunnelRequests[0]).toMatchObject({
      url: 'http://runner.local/api/browser-session/command',
      forwardedUser: 'user-1',
      body: JSON.stringify({
        type: 'browser-session:navigate',
        data: { sessionId: 'session-1', url: 'https://example.com' },
      }),
    });
    await waitFor(
      () => fixture!.tunnelDispatcher.activeTunnelCount('runner-1') === 0,
      'bodyless browser-session response did not complete',
    );
  });

  test('delivers each accepted runner event once to the owner and sharee stream rooms', async () => {
    const { io, capture } = createMockIo();
    fixture = await createProductionGrpcFixture({
      browserEvents: new SocketIoBrowserEventSink(io),
    });

    fixture.transport.publish({
      type: 'agent:result',
      threadId: 'thread-shared',
      data: { text: 'done' },
    } as any);
    await waitFor(
      () => capture.userRoomEmits.length === 2,
      'event was not delivered to browser rooms',
    );

    expect(capture.userRoomEmits).toEqual([
      {
        room: 'user:user-1',
        event: 'agent:result',
        payload: { type: 'agent:result', threadId: 'thread-shared', data: { text: 'done' } },
      },
      {
        room: 'thread:thread-shared:stream',
        event: 'agent:result',
        payload: { type: 'agent:result', threadId: 'thread-shared', data: { text: 'done' } },
      },
    ]);
  });

  test('isolates proxy, terminal, event, and browser-session routing for two users and runners', async () => {
    process.env.RUNNER_AUTH_SECRET = 'vertical-secret';
    const { io, capture } = createMockIo();
    const tunnelOwners: string[] = [];
    const runner = (runnerId: string, userId: string, token: string) => ({
      runnerId,
      userId,
      token,
      handleTunnel: async (request: Request) => {
        tunnelOwners.push(`${runnerId}:${new URL(request.url).pathname}`);
        return new Response(runnerId, { status: 200 });
      },
      handleTerminal: (command: any, respond: (event: any) => void) => {
        if (command.type === 'pty:write') {
          respond({
            type: 'pty:data',
            threadId: '',
            data: { ptyId: command.terminalId, data: `${runnerId}-output` },
          });
        }
      },
    });
    fixture = await createProductionGrpcFixture({
      browserEvents: new SocketIoBrowserEventSink(io),
      runners: [runner('runner-a', 'user-a', 'token-a'), runner('runner-b', 'user-b', 'token-b')],
    });

    const responseA = await fixture.endpoint.requests.request('runner-a', {
      method: 'GET',
      path: '/api/proxy/a',
      headers: {},
    });
    const responseB = await fixture.endpoint.requests.request('runner-b', {
      method: 'GET',
      path: '/api/proxy/b',
      headers: {},
    });
    expect([responseA.body, responseB.body]).toEqual(['runner-a', 'runner-b']);

    for (const [userId, runnerId] of [
      ['user-a', 'runner-a'],
      ['user-b', 'runner-b'],
    ] as const) {
      const socket = createMockSocket();
      const dependencies = {
        terminals: fixture.endpoint.terminals,
        requests: fixture.endpoint.requests,
        findAnyRunnerForUser: async () => runnerId,
        findRunnerForProject: async () => runnerId,
        getRunnerUserId: async () => userId,
        getProjectOwnerId: async () => userId,
      };
      setupBrowserPtyHandlers(socket, userId, dependencies);
      setupBrowserSessionHandlers(socket, userId, dependencies);
      await socket.trigger('pty:spawn', { projectId: `project-${userId}`, id: `pty-${userId}` });
      await socket.trigger('pty:write', {
        projectId: `project-${userId}`,
        id: `pty-${userId}`,
        data: 'whoami\n',
      });
      await socket.trigger('browser-session:navigate', {
        sessionId: `session-${userId}`,
        url: 'https://example.com',
      });
    }

    fixture.transports.get('runner-a')!.publish({
      type: 'agent:result',
      threadId: 'thread-a',
      data: { runner: 'runner-a' },
    } as any);
    fixture.transports.get('runner-b')!.publish({
      type: 'agent:result',
      threadId: 'thread-b',
      data: { runner: 'runner-b' },
    } as any);
    await waitFor(
      () =>
        capture.userRoomEmits.filter(({ event }) => event === 'pty:data').length === 2 &&
        capture.userRoomEmits.filter(({ event }) => event === 'agent:result').length === 4,
      'multi-runner browser deliveries did not complete',
    );

    expect(capture.userRoomEmits.filter(({ event }) => event === 'pty:data')).toEqual([
      expect.objectContaining({
        room: 'user:user-a',
        payload: expect.objectContaining({
          data: { ptyId: 'pty-user-a', data: 'runner-a-output' },
        }),
      }),
      expect.objectContaining({
        room: 'user:user-b',
        payload: expect.objectContaining({
          data: { ptyId: 'pty-user-b', data: 'runner-b-output' },
        }),
      }),
    ]);
    expect(capture.userRoomEmits.filter(({ event }) => event === 'agent:result')).toEqual([
      expect.objectContaining({
        room: 'user:user-a',
        payload: expect.objectContaining({ threadId: 'thread-a' }),
      }),
      expect.objectContaining({
        room: 'thread:thread-a:stream',
        payload: expect.objectContaining({ threadId: 'thread-a' }),
      }),
      expect.objectContaining({
        room: 'user:user-b',
        payload: expect.objectContaining({ threadId: 'thread-b' }),
      }),
      expect.objectContaining({
        room: 'thread:thread-b:stream',
        payload: expect.objectContaining({ threadId: 'thread-b' }),
      }),
    ]);
    expect(tunnelOwners).toEqual([
      'runner-a:/api/proxy/a',
      'runner-b:/api/proxy/b',
      'runner-a:/api/browser-session/command',
      'runner-b:/api/browser-session/command',
    ]);
  });

  test('propagates real tunnel deadlines and caller cancellation to the runner', async () => {
    let abortedRequests = 0;
    let startedRequests = 0;
    fixture = await createProductionGrpcFixture({
      handleTunnel: async (_request, signal) =>
        new Promise((_resolve, reject) => {
          startedRequests += 1;
          signal.addEventListener(
            'abort',
            () => {
              abortedRequests += 1;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });

    await expect(
      fixture.endpoint.requests.request('runner-1', {
        method: 'GET',
        path: '/slow',
        headers: {},
        deadlineAt: Date.now() + 25,
      }),
    ).rejects.toBeInstanceOf(RunnerRequestTimeoutError);

    const controller = new AbortController();
    const cancelled = fixture.endpoint.requests.request('runner-1', {
      method: 'GET',
      path: '/cancelled',
      headers: {},
      signal: controller.signal,
    });
    await waitFor(() => startedRequests === 2, 'cancellable request did not reach runner');
    controller.abort('browser disconnected');
    await expect(cancelled).rejects.toMatchObject({ code: FailureCode.CANCELLED });
    await waitFor(() => abortedRequests === 2, 'runner did not observe both abort signals');
  });

  test('drains a reload-sized request burst through a bounded real tunnel', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    fixture = await createProductionGrpcFixture({
      config: { maxActiveTunnels: 2 },
      handleTunnel: async (request) => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        try {
          await Bun.sleep(20);
          return new Response(JSON.stringify({ path: new URL(request.url).pathname }), {
            headers: { 'content-type': 'application/json' },
          });
        } finally {
          activeRequests -= 1;
        }
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture!.endpoint.requests.request('runner-1', {
          method: 'GET',
          path: `/api/git/thread-1/log?panel=${index}`,
          headers: {},
          deadlineAt: Date.now() + 2_000,
        }),
      ),
    );

    expect(responses).toHaveLength(10);
    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(maximumActiveRequests).toBe(2);
    expect(fixture.tunnelDispatcher.activeTunnelCount('runner-1')).toBe(0);
  });

  test('replaces a live session without a reconnect duel from the displaced runner', async () => {
    fixture = await createProductionGrpcFixture();
    let replacementActivated = false;
    let replacement: GrpcTeamTransport;
    replacement = new GrpcTeamTransport({
      endpoint: `${fixture.endpoint.host}:${fixture.endpoint.port}`,
      token: 'runner-token',
      runner: {
        instanceId: 'runner-1',
        name: 'replacement',
        hostname: 'replacement.local',
        operatingSystem: 'linux',
      },
      reconnectMinimumMs: 20,
      reconnectMaximumMs: 100,
      outbox: new GrpcOperationOutbox(':memory:'),
      events: new GrpcEventReplayStore(':memory:'),
      terminals: new GrpcTerminalReplayStore(),
      handleTunnel: async (request) =>
        new Response(JSON.stringify({ path: new URL(request.url).pathname, statuses: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      handleTerminal: (command, respond) => {
        if (command.type === 'pty:write') {
          respond({
            type: 'pty:data',
            threadId: '',
            data: { ptyId: command.terminalId, data: 'winner-terminal-ok' },
          });
        }
      },
      onActivated: () => {
        replacementActivated = true;
      },
    });
    replacement.start();
    try {
      await waitFor(() => replacementActivated, 'replacement session did not activate');
      await waitFor(
        () => !fixture!.transport.client.isActive(),
        'displaced production runner did not yield',
      );
      const winningEpoch = replacement.client.sessionEpoch();
      await Bun.sleep(1_100);
      expect(fixture.transport.client.isActive()).toBe(false);
      expect(replacement.client.isActive()).toBe(true);
      expect(replacement.client.sessionEpoch()).toBe(winningEpoch);
      expect(fixture.endpoint.presence.availableRunnerCount()).toBe(1);
      expect(fixture.endpoint.presence.userIdForRunner('runner-1')).toBe('user-1');

      await expect(
        fixture.endpoint.requests.request('runner-1', {
          method: 'GET',
          path: '/api/git/status?projectId=project-1',
          headers: {},
        }),
      ).resolves.toMatchObject({
        status: 200,
        body: JSON.stringify({ path: '/api/git/status', statuses: [] }),
      });
      fixture.dispatchTerminal('user-1', {
        type: 'pty:spawn',
        data: { id: 'pty-after-replacement', cwd: '/tmp' },
      });
      fixture.dispatchTerminal('user-1', {
        type: 'pty:write',
        data: { id: 'pty-after-replacement', data: 'pwd\n' },
      });
      await waitFor(
        () =>
          fixture!.terminalEvents.some(
            (event) =>
              (event.data as Record<string, unknown> | undefined)?.data === 'winner-terminal-ok',
          ),
        'terminal did not remain usable after replacement',
      );
    } finally {
      replacement.shutdown('test complete');
    }
  });

  test('carry control, operation, event, tunnel, and terminal traffic vertically', async () => {
    fixture = await createProductionGrpcFixture();

    expect(fixture.transport.client.sessionEpoch()).toBeTruthy();
    expect(fixture.endpoint.presence.isAvailable('runner-1')).toBe(true);
    expect(fixture.endpoint.requests.isAvailable('runner-1')).toBe(true);
    expect(fixture.endpoint.terminals.isAvailable('runner-1')).toBe(true);

    await expect(
      fixture.transport.request('data:get_project', { projectId: 'project-1' }),
    ).resolves.toEqual({
      type: 'data:get_project_response',
      project: { id: 'project-1', name: 'Vertical project' },
    });

    fixture.transport.publish({
      type: 'agent:result',
      threadId: 'thread-1',
      data: { text: 'done' },
    } as any);
    await waitFor(() => fixture!.events.length === 1, 'event was not accepted');
    expect(fixture.events[0]).toMatchObject({
      eventType: 'agent:result',
      data: { text: 'done' },
    });

    const exchange = fixture.dispatchTunnel({
      method: 'POST',
      path: '/api/vertical',
      headers: [{ name: 'content-type', value: 'text/plain' }],
      body: new TextEncoder().encode('tunnel-body'),
    });
    await expect(exchange.response).resolves.toEqual({
      statusCode: 201,
      headers: expect.arrayContaining([{ name: 'x-fixture', value: 'runtime' }]),
    });
    let tunnelBody = '';
    for await (const chunk of exchange.body) tunnelBody += new TextDecoder().decode(chunk);
    await exchange.completed;
    expect(tunnelBody).toBe('tunnel-body');

    fixture.dispatchTerminal('user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-1', cwd: '/tmp', cols: 80, rows: 24 },
    });
    fixture.dispatchTerminal('user-1', {
      type: 'pty:write',
      data: { id: 'pty-1', data: 'pwd\n' },
    });
    await waitFor(() => fixture!.terminalEvents.length === 1, 'terminal output was not relayed');
    expect(fixture.terminalEvents[0]).toMatchObject({
      type: 'pty:data',
      data: { ptyId: 'pty-1', data: 'terminal-ok' },
    });
  });

  test('preserves empty protobuf scalars and propagates persistence failures', async () => {
    const received: Array<Record<string, any>> = [];
    fixture = await createProductionGrpcFixture({
      executeOperation: async (request) => {
        received.push(request);
        if (request.type === 'data:insert_message') {
          return { type: 'data:insert_message_response', messageId: 'message-empty' };
        }
        if (request.type === 'data:insert_tool_call') {
          return { type: 'data:insert_tool_call_response', toolCallId: 'tool-call-1' };
        }
        return { type: 'data:ack', success: false, error: 'persistence failed' };
      },
    });

    await expect(
      fixture.transport.request('data:insert_message', {
        payload: { threadId: 'thread-1', role: 'assistant', content: '' },
      }),
    ).resolves.toEqual({ messageId: 'message-empty' });
    await expect(
      fixture.transport.request('data:insert_tool_call', {
        payload: { messageId: 'message-empty', name: 'Bash', input: '{}' },
      }),
    ).resolves.toEqual({ toolCallId: 'tool-call-1' });
    await expect(
      fixture.transport.request('data:update_thread', {
        payload: { threadId: 'thread-1', updates: { status: 'running' } },
      }),
    ).rejects.toThrow('persistence failed');

    expect(received[0]).toMatchObject({
      type: 'data:insert_message',
      payload: { threadId: 'thread-1', role: 'assistant', content: '' },
    });
    expect(received[1]).toMatchObject({
      type: 'data:insert_tool_call',
      payload: { messageId: 'message-empty', name: 'Bash', input: '{}' },
    });
  });

  test('confirms an ambiguous commit from the same durable outbox without reapplying it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-grpc-ambiguous-'));
    const outboxPath = join(directory, 'outbox.db');
    const idempotency = new MemoryOperationIdempotency();
    let applications = 0;
    let restartedTransport: GrpcTeamTransport | null = null;

    try {
      fixture = await createProductionGrpcFixture({
        outbox: new GrpcOperationOutbox(outboxPath),
        idempotency,
        executeOperation: async () => {
          applications += 1;
          return { success: true };
        },
      });
      idempotency.afterFirstExecution = async () => {
        fixture!.transport.shutdown('drop committed mutation outcome');
        await Bun.sleep(10);
      };

      await expect(
        fixture.transport.request('data:update_thread', {
          payload: { threadId: 'thread-1', updates: { title: 'Committed once' } },
        }),
      ).rejects.toThrow('shut down');
      expect(applications).toBe(1);
      expect(idempotency.executionCount).toBe(1);

      const restartedOutbox = new GrpcOperationOutbox(outboxPath);
      expect(restartedOutbox.pending()).toHaveLength(1);
      restartedTransport = new GrpcTeamTransport({
        endpoint: `${fixture.endpoint.host}:${fixture.endpoint.port}`,
        token: 'runner-token',
        runner: {
          instanceId: 'runner-1',
          name: 'restarted-production-fixture',
          hostname: 'fixture.local',
          operatingSystem: 'linux',
        },
        reconnectMinimumMs: 20,
        reconnectMaximumMs: 100,
        outbox: restartedOutbox,
        events: new GrpcEventReplayStore(':memory:'),
        terminals: new GrpcTerminalReplayStore(),
      });
      restartedTransport.start();

      await waitFor(
        () => restartedTransport!.client.isActive() && restartedOutbox.pending().length === 0,
        'restarted runtime did not confirm its committed outbox mutation',
      );
      expect(applications).toBe(1);
      expect(idempotency.executionCount).toBe(1);
      expect(idempotency.replayCount).toBe(1);
    } finally {
      restartedTransport?.shutdown('test complete');
      await fixture?.endpoint.shutdown(100);
      fixture = null;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

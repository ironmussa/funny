import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { RUNNER_AGENT_EVENT } from '@funny/shared/socket-events';
import { err } from 'neverthrow';

import * as dataHandler from '../../services/data-handler.js';
import * as projectRepository from '../../services/project-repository.js';
import * as runnerManager from '../../services/runner-manager.js';
import { setupBrowserPtyListRpc } from '../../services/socketio/browser-pty-list.js';
import { setupBrowserPtyHandlers } from '../../services/socketio/browser-pty.js';
import { setupBrowserSessionHandlers } from '../../services/socketio/browser-session.js';
import { setupRunnerControlHandlers } from '../../services/socketio/runner-control.js';
import { setupRunnerDataHandlers } from '../../services/socketio/runner-data.js';
import { setupRunnerEventHandlers } from '../../services/socketio/runner-events.js';
import { bindSocketIOServer, closeSocketIOServer } from '../../services/socketio/state.js';
import {
  addRunnerClient,
  removeRunnerClient,
  setIO as setRelayIO,
} from '../../services/ws-relay.js';
import { createMockIo, createMockSocket } from '../helpers/socketio-test-mocks.js';

function installMockIo(options?: Parameters<typeof createMockIo>[0]) {
  const { io, capture } = createMockIo(options);
  const ioWithClose = Object.assign(io, { close: () => {} });
  bindSocketIOServer(ioWithClose as any, {} as any, null, []);
  setRelayIO(ioWithClose as any);
  return capture;
}

function stubBrowserRouting(): void {
  spyOn(runnerManager, 'findAnyRunnerForUser').mockResolvedValue('runner-1');
  spyOn(runnerManager, 'findRunnerForProject').mockResolvedValue({
    runner: { runnerId: 'runner-1' },
  } as any);
  spyOn(runnerManager, 'getRunnerUserId').mockResolvedValue('user-1');
  spyOn(projectRepository, 'getProject').mockImplementation(async (projectId: string) =>
    projectId === 'owned'
      ? ({ userId: 'user-1', id: 'owned' } as any)
      : ({ userId: 'other', id: projectId } as any),
  );
}

describe('socketio browser handlers', () => {
  beforeEach(() => {
    removeRunnerClient('runner-1');
    addRunnerClient('runner-1', 'runner-sock-1', 'user-1');
    stubBrowserRouting();
  });

  afterEach(async () => {
    mock.restore();
    removeRunnerClient('runner-1');
    await closeSocketIOServer();
  });

  test('forwards PTY events to the runner socket', async () => {
    const capture = installMockIo();
    const socket = createMockSocket();
    setupBrowserPtyHandlers(socket, 'user-1');

    await socket.trigger('pty:write', { projectId: 'owned', data: 'ls' });

    expect(capture.centralBrowserWs).toHaveLength(1);
    expect(capture.centralBrowserWs[0]?.payload).toMatchObject({
      userId: 'user-1',
      data: { type: 'pty:write' },
    });
  });

  test('blocks cross-tenant PTY requests for foreign projects', async () => {
    installMockIo();
    const socket = createMockSocket();
    setupBrowserPtyHandlers(socket, 'user-1');

    await socket.trigger('pty:spawn', { projectId: 'foreign', id: 'pty-1' });

    expect(socket.emitted[0]).toEqual({
      event: 'pty:error',
      data: { ptyId: 'pty-1', error: 'Project not found' },
    });
  });

  test('forwards browser-session events to the user runner', async () => {
    const capture = installMockIo();
    const socket = createMockSocket();
    setupBrowserSessionHandlers(socket, 'user-1');

    await socket.trigger('browser-session:navigate', { url: 'https://example.com' });

    expect(capture.centralBrowserWs[0]?.payload).toMatchObject({
      data: { type: 'browser-session:navigate' },
    });
  });

  test('pty:list ack returns ok sessions from runner RPC', async () => {
    const runnerSocket = {
      timeout: (_ms: number) => ({
        emitWithAck: async () => ({ sessions: [{ id: 'pty-a' }] }),
      }),
    };
    installMockIo({ runnerSocket });
    const socket = createMockSocket();
    setupBrowserPtyListRpc(socket, 'user-1');

    let response: unknown;
    await socket.triggerRpc('pty:list', {}, (res) => {
      response = res;
    });

    expect(response).toEqual({ status: 'ok', sessions: [{ id: 'pty-a' }] });
  });

  test('pty:list ack returns no-runner when user has no runner', async () => {
    spyOn(runnerManager, 'findAnyRunnerForUser').mockResolvedValue(null);
    installMockIo();
    const socket = createMockSocket();
    setupBrowserPtyListRpc(socket, 'user-1');

    let response: unknown;
    await socket.triggerRpc('pty:list', {}, (res) => {
      response = res;
    });

    expect(response).toEqual({ status: 'no-runner', sessions: [] });
  });
});

describe('socketio runner handlers', () => {
  beforeEach(() => {
    removeRunnerClient('runner-1');
    addRunnerClient('runner-1', 'runner-sock-1', 'user-1');
  });

  afterEach(() => {
    mock.restore();
    removeRunnerClient('runner-1');
  });

  test('relays allowed runner agent events to the browser user', async () => {
    const socket = createMockSocket();
    const relayToUser = mock((_userId: string, _event: unknown) => {});
    setupRunnerEventHandlers({
      socket,
      runnerId: 'runner-1',
      runnerUserId: 'user-1',
      wsRelay: { relayToUser, relayToThreadStream: () => {} } as any,
    });

    await socket.trigger(RUNNER_AGENT_EVENT, {
      userId: 'user-1',
      event: { type: 'agent:message', threadId: 'th-1' },
    });

    expect(relayToUser).toHaveBeenCalled();
  });

  test('blocks cross-tenant runner agent events', async () => {
    const socket = createMockSocket();
    const relayToUser = mock((_userId: string, _event: unknown) => {});
    setupRunnerEventHandlers({
      socket,
      runnerId: 'runner-1',
      runnerUserId: 'user-1',
      wsRelay: { relayToUser, relayToThreadStream: () => {} } as any,
    });

    await socket.trigger(RUNNER_AGENT_EVENT, {
      userId: 'user-2',
      event: { type: 'agent:message' },
    });

    expect(relayToUser).not.toHaveBeenCalled();
  });

  test('runner:heartbeat ack returns wsConnected', async () => {
    spyOn(runnerManager, 'handleHeartbeat').mockResolvedValue(true);

    const socket = createMockSocket();
    setupRunnerControlHandlers(socket, 'runner-1');

    let response: unknown;
    await socket.triggerRpc('runner:heartbeat', { activeThreadIds: [] }, (res) => {
      response = res;
    });

    expect(response).toEqual({ ok: true, wsConnected: true });
  });

  test('runner:assign_project rejects cross-tenant project access', async () => {
    spyOn(projectRepository, 'resolveProjectPath').mockResolvedValue(
      err({ message: 'Forbidden' } as any),
    );

    const socket = createMockSocket({ data: { runnerUserId: 'user-1' } } as any);
    setupRunnerControlHandlers(socket, 'runner-1');

    let response: unknown;
    await socket.triggerRpc(
      'runner:assign_project',
      { projectId: 'p-foreign', localPath: '/tmp/x' },
      (res) => {
        response = res;
      },
    );

    expect(response).toEqual({ ok: false, error: 'Forbidden' });
  });

  test('runner data handler emits data:response for requestId messages', async () => {
    spyOn(dataHandler, 'handleDataMessageWithAck').mockResolvedValue({
      success: true,
      id: 'msg-1',
    } as any);

    const socket = createMockSocket();
    setupRunnerDataHandlers(socket, 'runner-1', 'user-1');

    await socket.trigger('data:insert_message', { _requestId: 'req-1', payload: {} });

    expect(socket.emitted[0]?.event).toBe('data:response');
  });
});

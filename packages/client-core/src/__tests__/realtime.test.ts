import { describe, expect, test } from 'bun:test';

import {
  createRealtimeController,
  createRealtimeDispatcher,
  getSidebarResyncTargets,
  type RealtimeActionPorts,
  type RealtimeEffect,
  type RealtimeEvent,
} from '../realtime';
import { createInMemoryPlatform } from '../testing/in-memory-platform';

describe('realtime core', () => {
  test('routes typed events through narrow ports and emits semantic effects', () => {
    const actions: Array<{ port: keyof RealtimeActionPorts; event: RealtimeEvent }> = [];
    const effects: RealtimeEffect[] = [];
    const port = (name: keyof RealtimeActionPorts) => (event: RealtimeEvent) =>
      actions.push({ port: name, event });
    const dispatcher = createRealtimeDispatcher({
      actions: {
        agent: port('agent'),
        terminal: port('terminal'),
        thread: port('thread'),
        git: port('git'),
        automation: port('automation'),
        pipeline: port('pipeline'),
        workflow: port('workflow'),
        presence: port('presence'),
        testing: port('testing'),
        browserSession: port('browserSession'),
        infrastructure: port('infrastructure'),
      },
      effects: { emit: (effect) => effects.push(effect) },
    });

    dispatcher.dispatch({
      type: 'agent:result',
      threadId: 't1',
      data: { status: 'failed', errorReason: 'timeout' },
    });
    dispatcher.dispatch({
      type: 'pty:error',
      threadId: 't1',
      data: { ptyId: 'pty-1', error: 'shell failed' },
    });
    dispatcher.dispatch({
      type: 'worktree:setup',
      threadId: 't1',
      data: { step: 'clone' },
    });
    dispatcher.dispatch({
      type: 'git:workflow_progress',
      threadId: 't1',
      data: {
        status: 'step_update',
        steps: [{ id: 'hooks', status: 'failed', error: 'lint failed' }],
      },
    });

    expect(actions.map((value) => value.port)).toEqual([
      'agent',
      'terminal',
      'infrastructure',
      'git',
    ]);
    expect(effects).toEqual([
      { type: 'agent-result', threadId: 't1', status: 'failed', errorReason: 'timeout' },
      { type: 'terminal-error', ptyId: 'pty-1', message: 'shell failed' },
      {
        type: 'application-event',
        name: 'worktree:setup',
        detail: { threadId: 't1', step: 'clone' },
      },
      { type: 'hook-failed', message: 'lint failed' },
    ]);
  });

  test('gates reconnect and focus resync using lifecycle, route, connection, and throttle', () => {
    const host = createInMemoryPlatform({
      location: { pathname: '/projects/p1/threads/t1' },
      lifecycle: { focused: false, visible: false },
    });
    let connected = true;
    let now = 10_000;
    const focus: string[] = [];
    let reconnects = 0;
    const skipped: string[] = [];
    const controller = createRealtimeController({
      lifecycle: host.platform.lifecycle,
      navigation: host.platform.navigation,
      connected: () => connected,
      routeEligible: (pathname) => pathname.startsWith('/projects/'),
      clock: () => now,
      actions: {
        refreshForFocus: (reason) => focus.push(reason),
        refreshForReconnect: () => reconnects++,
        skipped: (_reason, cause) => skipped.push(cause),
      },
    });
    const stop = controller.start();
    expect(controller.handleConnected()).toBe(false);
    expect(controller.handleConnected()).toBe(true);
    expect(reconnects).toBe(1);

    host.controls.setLifecycle({ visible: true });
    expect(focus).toEqual(['visibility']);
    now += 100;
    host.controls.setLifecycle({ focused: true });
    expect(skipped).toContain('throttled');
    now += 3_000;
    connected = false;
    controller.considerFocusResync('focus');
    expect(skipped).toContain('disconnected');
    stop();
  });

  test('selects only active loaded sidebar slices', () => {
    expect(
      getSidebarResyncTargets({
        threadIdsByProject: { p1: ['t1'], p2: ['t2'] },
        threadsById: {
          t1: { status: 'running' },
          t2: { status: 'completed' },
          s1: { status: 'waiting' },
        },
        scratchThreadIds: ['s1'],
        sharedThreadIds: ['t2'],
      }),
    ).toEqual({ projectIds: ['p1'], scratch: true, shared: false });
  });
});

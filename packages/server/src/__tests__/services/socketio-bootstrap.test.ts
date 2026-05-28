import { mock } from 'bun:test';

let browserNamespaceCalled = 0;
let runnerNamespaceCalled = 0;

mock.module('../../services/socketio/browser-namespace.js', () => ({
  setupBrowserNamespace: () => {
    browserNamespaceCalled++;
  },
}));

mock.module('../../services/socketio/runner-namespace.js', () => ({
  setupRunnerNamespace: () => {
    runnerNamespaceCalled++;
  },
}));

import { afterEach, describe, expect, test } from 'bun:test';

import { closeSocketIO, createSocketIOServer, getEngine, getIO } from '../../services/socketio.js';
import { allowedOrigins, authInstance } from '../../services/socketio/state.js';

describe('socketio bootstrap', () => {
  afterEach(async () => {
    await closeSocketIO();
  });

  test('createSocketIOServer wires engine, auth, and namespaces', () => {
    browserNamespaceCalled = 0;
    runnerNamespaceCalled = 0;
    const auth = { api: { getSession: async () => null } };

    const { io, engine } = createSocketIOServer(auth, ['http://localhost:5173']);

    expect(io).toBeDefined();
    expect(engine).toBeDefined();
    expect(getIO()).toBe(io);
    expect(getEngine()).toBe(engine);
    expect(authInstance).toBe(auth);
    expect(allowedOrigins).toEqual(['http://localhost:5173']);
    expect(browserNamespaceCalled).toBe(1);
    expect(runnerNamespaceCalled).toBe(1);
  });

  test('closeSocketIO clears server state', async () => {
    createSocketIOServer({ api: {} }, ['http://localhost:5173']);
    await closeSocketIO();
    expect(() => getIO()).toThrow(/not initialized/);
  });
});

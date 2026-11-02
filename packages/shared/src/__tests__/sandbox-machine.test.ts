import { describe, expect, test } from 'bun:test';

import {
  ACTIVE_SANDBOX_STATES,
  nextSandboxState,
  sandboxTransitionsFor,
} from '../sandbox-machine.js';

describe('sandbox machine', () => {
  test('the provisioning path, with and without a runner template', () => {
    expect(nextSandboxState('provisioning', 'INSTALL')).toBe('installing');
    expect(nextSandboxState('installing', 'CONNECT')).toBe('connecting');
    expect(nextSandboxState('provisioning', 'CONNECT')).toBe('connecting');
    expect(nextSandboxState('connecting', 'BOOTSTRAP')).toBe('bootstrapping');
    expect(nextSandboxState('bootstrapping', 'READY')).toBe('running');
    expect(nextSandboxState('connecting', 'READY')).toBe('running');
  });

  test('stop and resume', () => {
    expect(nextSandboxState('running', 'STOP')).toBe('stopping');
    expect(nextSandboxState('stopping', 'STOPPED')).toBe('stopped');
    expect(nextSandboxState('stopped', 'RESUME')).toBe('connecting');
    // A refused stop leaves the machine running.
    expect(nextSandboxState('stopping', 'STOP_FAILED')).toBe('running');
  });

  test('illegal transitions are refused', () => {
    expect(nextSandboxState('provisioning', 'STOP')).toBeNull();
    expect(nextSandboxState('running', 'RESUME')).toBeNull();
    expect(nextSandboxState('stopped', 'READY')).toBeNull();
    // failed / lost are final: only a new generation replaces them.
    expect(nextSandboxState('failed', 'RESUME')).toBeNull();
    expect(nextSandboxState('lost', 'FAIL')).toBeNull();
  });

  test('FAIL and LOST are accepted from every non-final state', () => {
    expect(sandboxTransitionsFor('FAIL')).toEqual({
      from: [
        'provisioning',
        'installing',
        'connecting',
        'bootstrapping',
        'running',
        'stopping',
        'stopped',
      ],
      to: 'failed',
    });
    expect(sandboxTransitionsFor('LOST')?.to).toBe('lost');
  });

  test('an event leads to one state whatever its source', () => {
    expect(sandboxTransitionsFor('CONNECT')).toEqual({
      from: ['provisioning', 'installing'],
      to: 'connecting',
    });
    expect(sandboxTransitionsFor('READY')).toEqual({
      from: ['connecting', 'bootstrapping'],
      to: 'running',
    });
  });

  test('active states are the ones with a machine being prepared or used', () => {
    expect([...ACTIVE_SANDBOX_STATES]).toEqual([
      'provisioning',
      'installing',
      'connecting',
      'bootstrapping',
      'running',
    ]);
  });
});

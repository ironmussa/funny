import { describe, expect, test } from 'bun:test';

import { BrowserV1OutboundQueue } from '../../services/socketio/browser-v1-outbound-queue.js';

function queue() {
  return new BrowserV1OutboundQueue({
    maxMessagesPerClass: 2,
    maxBytesPerClass: 10,
    maxConcurrentPerClass: 1,
    reservedControlMessages: 1,
  });
}

describe('browser.v1 outbound queue', () => {
  test('bounds messages and bytes while distinguishing droppable exhaustion', () => {
    const outbound = queue();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(
      outbound.enqueue('events', {
        byteLength: 4,
        droppable: false,
        priority: 'normal',
        send: () => pending,
      }),
    ).toBe('accepted');
    for (let index = 0; index < 2; index += 1) {
      expect(
        outbound.enqueue('events', {
          byteLength: 4,
          droppable: false,
          priority: 'normal',
          send: () => {},
        }),
      ).toBe('accepted');
    }
    expect(
      outbound.enqueue('events', {
        byteLength: 1,
        droppable: true,
        priority: 'bulk',
        send: () => {},
      }),
    ).toBe('dropped');
    expect(
      outbound.enqueue('events', {
        byteLength: 1,
        droppable: false,
        priority: 'normal',
        send: () => {},
      }),
    ).toBe('exhausted');
    release();
  });

  test('coalesces latest-state messages and reserves control capacity', () => {
    const outbound = queue();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    outbound.enqueue('terminal', {
      byteLength: 1,
      droppable: false,
      priority: 'normal',
      send: () => pending,
    });
    outbound.enqueue('terminal', {
      byteLength: 3,
      coalescingKey: 'resize:pty-1',
      droppable: true,
      priority: 'bulk',
      send: () => {},
    });
    expect(
      outbound.enqueue('terminal', {
        byteLength: 4,
        coalescingKey: 'resize:pty-1',
        droppable: true,
        priority: 'bulk',
        send: () => {},
      }),
    ).toBe('coalesced');
    expect(
      outbound.enqueue('terminal', {
        byteLength: 2,
        droppable: false,
        priority: 'control',
        send: () => {},
      }),
    ).toBe('accepted');
    expect(outbound.stats('terminal')).toEqual({ active: 1, messages: 2, bytes: 6 });
    release();
  });
});

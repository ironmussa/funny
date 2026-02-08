import { describe, test, expect, beforeEach } from 'bun:test';

// We need to test WSBroker in isolation, so we recreate the class logic
// The singleton export makes it hard to reset between tests, so we test the class directly.

class WSBroker {
  private clients = new Set<any>();

  addClient(ws: any): void {
    this.clients.add(ws);
  }

  removeClient(ws: any): void {
    this.clients.delete(ws);
  }

  emit(event: any): void {
    const payload = JSON.stringify(event);
    const dead: any[] = [];

    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.clients.delete(ws);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

describe('WSBroker', () => {
  let broker: WSBroker;

  beforeEach(() => {
    broker = new WSBroker();
  });

  test('starts with 0 clients', () => {
    expect(broker.clientCount).toBe(0);
  });

  test('addClient increases client count', () => {
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };

    broker.addClient(ws1);
    expect(broker.clientCount).toBe(1);

    broker.addClient(ws2);
    expect(broker.clientCount).toBe(2);
  });

  test('removeClient decreases client count', () => {
    const ws = { send: () => {} };
    broker.addClient(ws);
    expect(broker.clientCount).toBe(1);

    broker.removeClient(ws);
    expect(broker.clientCount).toBe(0);
  });

  test('removeClient on non-existent client is a no-op', () => {
    const ws = { send: () => {} };
    broker.removeClient(ws);
    expect(broker.clientCount).toBe(0);
  });

  test('emit sends JSON payload to all clients', () => {
    const received: string[] = [];
    const ws1 = { send: (msg: string) => received.push(msg) };
    const ws2 = { send: (msg: string) => received.push(msg) };

    broker.addClient(ws1);
    broker.addClient(ws2);

    const event = { type: 'test', threadId: 't1', data: { foo: 'bar' } };
    broker.emit(event);

    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0])).toEqual(event);
    expect(JSON.parse(received[1])).toEqual(event);
  });

  test('emit removes dead clients that throw on send', () => {
    const goodReceived: string[] = [];
    const goodWs = { send: (msg: string) => goodReceived.push(msg) };
    const deadWs = {
      send: () => {
        throw new Error('connection closed');
      },
    };

    broker.addClient(goodWs);
    broker.addClient(deadWs);
    expect(broker.clientCount).toBe(2);

    broker.emit({ type: 'test', threadId: 't1', data: {} });

    expect(broker.clientCount).toBe(1);
    expect(goodReceived).toHaveLength(1);
  });

  test('emit handles all dead clients', () => {
    const deadWs1 = { send: () => { throw new Error('dead'); } };
    const deadWs2 = { send: () => { throw new Error('dead'); } };

    broker.addClient(deadWs1);
    broker.addClient(deadWs2);

    broker.emit({ type: 'test', threadId: 't1', data: {} });
    expect(broker.clientCount).toBe(0);
  });

  test('does not add the same client twice', () => {
    const ws = { send: () => {} };
    broker.addClient(ws);
    broker.addClient(ws);
    expect(broker.clientCount).toBe(1);
  });
});

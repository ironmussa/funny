import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ScriptRunner } from '../script-runner.ts';

const originalSpawn = Bun.spawn;

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

beforeEach(() => {
  (Bun as any).spawn = originalSpawn;
});

afterEach(() => {
  (Bun as any).spawn = originalSpawn;
});

describe('ScriptRunner', () => {
  it('runs a predefined script and emits lifecycle/log events', async () => {
    const runner = new ScriptRunner();
    const events: Array<[string, any]> = [];
    const spawnCalls: any[] = [];

    runner.on('start', (payload) => events.push(['start', payload]));
    runner.on('log', (payload) => events.push(['log', payload]));
    runner.on('done', (payload) => events.push(['done', payload]));

    (Bun as any).spawn = ((cmd: string[], options: any) => {
      spawnCalls.push({ cmd, env: options.env });
      return {
        stdout: streamFromText('hello\nworld\n'),
        stderr: streamFromText('warn\n'),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as typeof Bun.spawn;

    await runner.run({
      script: 'demo-search',
      cdpUrl: 'http://localhost:9322',
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd[0]).toBe('bun');
    expect(spawnCalls[0].cmd[1]).toBe('run');
    expect(
      spawnCalls[0].cmd[2].endsWith('scripts\\demo-search.ts') ||
        spawnCalls[0].cmd[2].endsWith('scripts/demo-search.ts'),
    ).toBe(true);
    expect(spawnCalls[0].env.CDP_URL).toBe('http://localhost:9322');
    expect(events[0]).toEqual(['start', { script: 'demo-search' }]);
    expect(events).toContainEqual(['log', { line: 'hello', stream: 'stdout' }]);
    expect(events).toContainEqual(['log', { line: 'world', stream: 'stdout' }]);
    expect(events).toContainEqual(['log', { line: 'warn', stream: 'stderr' }]);
    expect(events.at(-1)).toEqual(['done', { exitCode: 0 }]);
    expect(runner.isRunning()).toBe(false);
  });

  it('emits an error event when the script exits non-zero', async () => {
    const runner = new ScriptRunner();
    const events: Array<[string, any]> = [];

    runner.on('error', (payload) => events.push(['error', payload]));

    (Bun as any).spawn = ((_: string[], __: any) =>
      ({
        stdout: streamFromText(''),
        stderr: streamFromText(''),
        exited: Promise.resolve(2),
        kill() {},
      }) as any) as typeof Bun.spawn;

    await runner.run({ script: 'demo-search' });

    expect(events).toEqual([['error', { exitCode: 2, message: 'Script exited with code 2' }]]);
  });

  it('rejects a custom script without code', async () => {
    const runner = new ScriptRunner();

    await expect(
      runner.run({
        script: 'custom',
      }),
    ).rejects.toThrow('Custom script requires code');
  });

  it('stops a running process and emits stopped', async () => {
    const runner = new ScriptRunner();
    const killed: string[] = [];
    const events: string[] = [];

    runner.on('stopped', () => events.push('stopped'));

    let resolveExit!: (value: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    (Bun as any).spawn = ((_: string[], __: any) =>
      ({
        stdout: streamFromText(''),
        stderr: streamFromText(''),
        exited,
        kill(signal?: string) {
          killed.push(signal ?? 'default');
          resolveExit(0);
        },
      }) as any) as typeof Bun.spawn;

    const runPromise = runner.run({ script: 'demo-search' });
    expect(runner.isRunning()).toBe(true);

    runner.stop();
    await runPromise;

    expect(killed).toHaveLength(1);
    expect(events).toEqual(['stopped']);
    expect(runner.isRunning()).toBe(false);
  });
});

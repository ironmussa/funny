import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

const rpcMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z
    .object({
      threadId: z.string().optional(),
      item: z
        .object({ type: z.string(), text: z.string().optional(), review: z.string().optional() })
        .passthrough()
        .optional(),
      turn: z
        .object({ status: z.string(), error: z.object({ message: z.string() }).nullish() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export interface CodexNotification {
  method: string;
  params: NonNullable<z.infer<typeof rpcMessageSchema>['params']>;
}

/** A short-lived stdio connection for native operations missing from the SDK. */
export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(event: CodexNotification) => void>();
  private failure: Error | undefined;

  constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    private signal: AbortSignal,
  ) {
    this.process = spawn(env.CODEX_BINARY_PATH || env.CODEX_BIN || 'codex', ['app-server'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      try {
        const parsed = parseStoredJson(rpcMessageSchema, line, 'Codex App Server');
        if (!parsed.ok) throw new Error(parsed.error);
        const message = parsed.value;
        if (message.method && message.id != null) {
          // Never silently grant an approval the host cannot display.
          this.write({
            id: message.id,
            error: {
              code: -32601,
              message:
                'Interactive requests are unavailable for this command. Use the Codex terminal.',
            },
          });
        } else if (message.id != null) {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error.message));
          else request?.resolve(message.result);
        } else if (message.method) {
          for (const listener of this.listeners)
            listener({ method: message.method, params: message.params ?? {} });
        }
      } catch {
        this.fail(new Error('Invalid Codex App Server response'));
      }
    });
    this.process.stderr.resume();
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.on('error', (error) => this.fail(error));
    this.process.on('exit', () => {
      lines.close();
      this.fail(new Error('Codex App Server exited before the operation completed'));
    });
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  private abort = () => {
    this.fail(new Error('Codex command cancelled'));
    this.close();
  };

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: 'connection/error', params: { error } });
  }

  private write(message: unknown) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'funny', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex ${method} timed out`));
        }, 30_000);
        this.write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Register before sending: completion can arrive before the RPC response. */
  async runTurn(
    method: string,
    params: { threadId: string; [key: string]: unknown },
  ): Promise<string> {
    let output = '';
    let listener: (event: CodexNotification) => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = new Promise<string>((resolve, reject) => {
      listener = (event) => {
        if (event.method === 'connection/error') return reject(event.params.error);
        if (event.params?.threadId !== params.threadId) return;
        if (event.method === 'item/completed') {
          const item = event.params.item;
          if (item?.type === 'agentMessage' && item.text) output += `${item.text}\n`;
          if (item?.type === 'exitedReviewMode' && item.review) output += `${item.review}\n`;
        }
        if (event.method === 'turn/completed') {
          const turn = event.params.turn;
          if (!turn) return reject(new Error('Missing Codex turn result'));
          if (turn.status !== 'completed')
            reject(new Error(turn.error?.message ?? `Codex turn ${turn.status}`));
          else resolve(output.trim());
        }
      };
      this.listeners.add(listener);
      timer = setTimeout(() => reject(new Error('Codex operation timed out')), 10 * 60_000);
    });
    try {
      const [, result] = await Promise.all([this.request(method, params), completion]);
      return result;
    } finally {
      clearTimeout(timer);
      this.listeners.delete(listener);
    }
  }

  private closed = false;

  close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Codex App Server connection closed'));
    this.signal.removeEventListener('abort', this.abort);
    this.process.kill('SIGTERM');
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 1000);
    timer.unref();
    this.process.once('exit', () => clearTimeout(timer));
  }
}

export function codexReviewTarget(args: string) {
  if (!args) return { type: 'uncommittedChanges' };
  const option = /^--(base|commit)\s+(\S+)$/.exec(args);
  if (option?.[1] === 'base') return { type: 'baseBranch', branch: option[2] };
  if (option?.[1] === 'commit') return { type: 'commit', sha: option[2], title: null };
  if (args.startsWith('--'))
    throw new Error('Usage: /review [--base branch | --commit sha | instructions]');
  return { type: 'custom', instructions: args };
}

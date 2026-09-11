import { createConnection } from 'node:net';

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.literal(1),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/** One bounded, cancellable request to an owned local tgrep process. */
export function tgrepRpc(
  port: number,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  limits = { timeoutMs: 10_000, maxBytes: 8 * 1_048_576 },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error('cancelled'));
    const timer = setTimeout(() => finish(new Error('timeout')), limits.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('transport')));
    socket.on('close', () => finish(new Error('closed')));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) return finish(new Error('reply-limit'));
      const newline = chunk.indexOf(10);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      if (newline < 0) return;
      const parsed = parseStoredJson(envelopeSchema, Buffer.concat(chunks).toString('utf8'));
      if (!parsed.ok || parsed.value.error !== undefined || parsed.value.result === undefined) {
        finish(new Error('protocol'));
        return;
      }
      finish(undefined, parsed.value.result);
    });
  });
}

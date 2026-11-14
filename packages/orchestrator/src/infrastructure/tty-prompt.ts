/**
 * Asks for a secret on the terminal without echoing it. A one-line secret
 * ends at Enter; a multi-line one (a pasted PEM key) at the Enter after its
 * `-----END …-----` line. Ctrl-C or Ctrl-D gives up (null).
 */

import type { SecretPrompt } from '../settings/secrets.js';

type Typed = { buffer: string } | { done: string | null };

/** One typed character: the text so far, or the answer once it is complete. */
export function typeSecretChar(buffer: string, char: string, multiline: boolean): Typed {
  if (char === '\u0003' || char === '\u0004') return { done: null };
  if (char === '\u007f' || char === '\b') return { buffer: buffer.slice(0, -1) };
  if (char !== '\r' && char !== '\n') return { buffer: buffer + char };
  const complete = !multiline || /-----END [A-Z ]+-----\s*$/.test(buffer);
  return complete ? { done: buffer } : { buffer: `${buffer}\n` };
}

export const ttyPrompt: SecretPrompt = (question, secret) =>
  new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question + (secret.multiline ? '\n(paste it, then press Enter)\n' : ''));
    let buffer = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        const typed = typeSecretChar(buffer, char, secret.multiline);
        if ('buffer' in typed) {
          buffer = typed.buffer;
          continue;
        }
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write('\n');
        return resolve(typed.done);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });

/**
 * What a read-only role reads besides its checkout (`threads.read_only`): the
 * issue's text for triage and for a reviewer without a contract. The server
 * sends it with the thread's creation (`roleInputs`) and the runner writes it
 * here, one private folder per thread outside the checkout, because the agent
 * has no network to read GitHub, and because text anyone can write (an issue,
 * its comments) reaches the model as a tool's output, which it treats as data,
 * never inlined in the prompt, where it would read as instructions.
 *
 * The agent finds the folder in `FUNNY_ROLE_INPUTS`; its read tools may read
 * it (`readOnlyRoots` in `@funny/core`).
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isReadOnlyThread } from '../thread-context.js';

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** File name → text (validated by `createThreadSchema.roleInputs`). */
export type RoleInputs = Record<string, string>;

/** The folder of a thread's role inputs, or null for an id of an unexpected shape. */
export function roleInputsDirFor(threadId: string): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  return join(tmpdir(), `funny-role-inputs-${process.getuid?.() ?? 0}`, threadId);
}

/** Write a thread's role inputs (only its owner can read them). */
export async function writeRoleInputs(threadId: string, inputs: RoleInputs): Promise<void> {
  const dir = roleInputsDirFor(threadId);
  if (!dir || Object.keys(inputs).length === 0) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(join(dir, '..'), 0o700);
  await Promise.all(
    Object.entries(inputs).map(([name, text]) => writeFile(join(dir, name), text, { mode: 0o600 })),
  );
}

/** The folder of a thread's role inputs when it has any, else null. */
export function existingRoleInputsDir(threadId: string): string | null {
  const dir = roleInputsDirFor(threadId);
  return dir && existsSync(dir) ? dir : null;
}

/**
 * The role inputs a message brings (a sandbox thread's first message, whose
 * row the server creates): written only from the owner, and only for a
 * read-only thread.
 */
export async function adoptRoleInputs(
  thread: { readOnly?: number | boolean | null },
  threadId: string,
  inputs: RoleInputs | undefined,
  fromOwner: boolean,
): Promise<void> {
  if (!inputs || !fromOwner || !isReadOnlyThread(thread)) return;
  await writeRoleInputs(threadId, inputs);
}

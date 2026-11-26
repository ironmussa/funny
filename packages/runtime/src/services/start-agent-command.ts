/**
 * The `startAgent` control command (`StartAgentCommand` in
 * protocol/runner/v2/control.proto) as the runner decodes it: proto3 JSON, so
 * an empty field is absent and `images` (repeated bytes) are base64 strings.
 *
 * A field of the wrong type reads as absent, as the earlier
 * `String(input.x ?? '')` / `input.x || undefined` reads did, so the server's
 * commands start the same agents as before. Two things fail the parse: a
 * command that is not an object, and a permission mode funny does not know.
 * The mode fails closed: read as absent, it would start the agent with
 * `startAgent`'s default (`autoEdit`), more than the thread was given.
 */

import { PERMISSION_MODE_VALUES } from '@funny/shared/contracts/threads';
import { z } from 'zod';

const text = z.string().catch('');

/** A string field that reads as absent when empty or missing (`|| undefined`). */
const optionalText = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => value || undefined);

const stringList = z.array(z.string()).optional().catch(undefined);

export const startAgentCommandSchema = z.object({
  threadId: text,
  prompt: text,
  cwd: text,
  /** The model the server stored for the thread; the agent start resolves it. */
  model: optionalText,
  permissionMode: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(PERMISSION_MODE_VALUES).optional(),
  ),
  provider: optionalText,
  images: stringList,
  allowedTools: stringList,
  disallowedTools: stringList,
});

export type StartAgentCommand = z.output<typeof startAgentCommandSchema>;

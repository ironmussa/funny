/**
 * Reconstructs why a `waiting` thread waits (question, plan or tool
 * permission) from its latest persisted tool calls.
 */

import { eq, desc } from 'drizzle-orm';

import type { RepoDeps } from '../deps.js';

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const PERMISSION_PENDING_OUTPUT =
  /(?:requested permissions? to (?:use|edit)|is a sensitive file|hasn't been granted|hasn't granted|not in the allowed tools list|hook error:.*(?:approval|permission)|denied this tool|Blocked by hook|Waiting for user approval)/i;

export async function findPendingWaitState(deps: RepoDeps, threadId: string, status: string) {
  if (status !== 'waiting') return {};

  const { db, schema, dbAll } = deps;
  const latestToolCalls = await dbAll(
    db
      .select({
        id: schema.toolCalls.id,
        name: schema.toolCalls.name,
        input: schema.toolCalls.input,
        output: schema.toolCalls.output,
      })
      .from(schema.toolCalls)
      .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(desc(schema.messages.timestamp))
      .limit(25),
  );

  const pendingInteractive = latestToolCalls.find(
    (tc) => INTERACTIVE_TOOLS.has(tc.name) && !tc.output,
  );
  if (pendingInteractive?.name === 'AskUserQuestion') return { waitingReason: 'question' };
  if (pendingInteractive?.name === 'ExitPlanMode') return { waitingReason: 'plan' };

  const pendingPermission = latestToolCalls.find((tc) => {
    if (INTERACTIVE_TOOLS.has(tc.name)) return false;
    if (!tc.output) return true;
    return PERMISSION_PENDING_OUTPUT.test(tc.output);
  });
  if (!pendingPermission) return {};

  return {
    waitingReason: 'permission',
    pendingPermission: {
      toolName: pendingPermission.name,
      toolInput: pendingPermission.input,
    },
  };
}

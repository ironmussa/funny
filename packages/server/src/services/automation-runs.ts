/**
 * Automation run completion. Called when a runner persists a terminal status
 * for a thread (`data-handler.ts` → `notifyTerminalStatusPersisted`) — the
 * durable "thread finished" signal — so runs complete without polling and
 * without the owner having a browser open.
 *
 * @domain subdomain: Automation
 * @domain type: app-service
 * @domain layer: application
 */

import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import * as automationRepo from './automation-repository.js';
import { relayToUser } from './browser-events.js';

const SUMMARY_MAX_CHARS = 500;

/**
 * Complete the automation run attached to `threadId`, if any. Idempotent: only
 * a run still `running` is updated; any other thread is ignored.
 */
export async function onAutomationThreadTerminal(threadId: string, status: string): Promise<void> {
  const run = await automationRepo.getRunByThreadId(threadId);
  if (!run || run.status !== 'running') return;
  const automation = await automationRepo.getAutomation(run.automationId);
  if (!automation) return;

  const completed = status === 'completed';
  const summary = (await lastAssistantReply(threadId)) ?? 'No summary available';
  await automationRepo.updateRun(run.id, {
    status: completed ? 'completed' : 'failed',
    hasFindings: completed ? 1 : 0,
    summary,
    completedAt: new Date().toISOString(),
  });

  relayToUser(automation.userId, {
    type: 'automation:run_completed',
    threadId,
    data: { automationId: automation.id, runId: run.id, hasFindings: completed, summary },
  });

  await archiveRunsBeyondHistory(automation.id, automation.maxRunHistory);
}

async function lastAssistantReply(threadId: string): Promise<string | null> {
  const row = (await dbGet(
    db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.role, 'assistant')))
      .orderBy(desc(schema.messages.timestamp))
      .limit(1),
  )) as { content: string } | undefined;
  return row?.content ? row.content.slice(0, SUMMARY_MAX_CHARS) : null;
}

/** Archive the threads of finished runs older than the newest `maxRunHistory`. */
async function archiveRunsBeyondHistory(automationId: string, maxRunHistory: number) {
  const finished = (await dbAll(
    db
      .select({ threadId: schema.automationRuns.threadId })
      .from(schema.automationRuns)
      .where(
        and(
          eq(schema.automationRuns.automationId, automationId),
          ne(schema.automationRuns.status, 'running'),
        ),
      )
      .orderBy(desc(schema.automationRuns.startedAt)),
  )) as { threadId: string }[];
  const old = finished.slice(Math.max(0, maxRunHistory)).map((r) => r.threadId);
  if (old.length === 0) return;
  await dbRun(
    db
      .update(schema.threads)
      .set({ archived: 1 })
      .where(and(inArray(schema.threads.id, old), eq(schema.threads.archived, 0))),
  );
  log.info('Archived automation runs beyond history limit', {
    namespace: 'automation',
    automationId,
    count: old.length,
  });
}

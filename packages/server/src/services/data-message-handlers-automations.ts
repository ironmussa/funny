/**
 * @domain subdomain: Automation
 * @domain subdomain-type: core
 * @domain type: handler
 * @domain layer: application
 *
 * Executors for runner → server data messages about scheduled automations,
 * part of the dispatch table in `data-message-handlers.ts`. Callers run the
 * ownership and project-scope checks first; `automationAgentTools` takes the
 * actor and project from the thread row and decides every refusal.
 */

import {
  agentCreateAutomationInput,
  agentUpdateAutomationPatch,
  automationAgentTools,
} from './automation-agent-tools.js';
import type { DataMessageHandlers } from './data-message-handler-types.js';

export const AUTOMATION_DATA_HANDLERS: DataMessageHandlers = {
  'data:automation_list': async ({ runnerId, ownerId, data }) => {
    const type = 'data:automation_list_response';
    const listed = await automationAgentTools.list({
      threadId: String(data.threadId),
      runnerId,
      runnerOwnerId: ownerId,
    });
    return listed.isOk()
      ? { type, automations: listed.value }
      : { type, error: listed.error.kind, message: listed.error.message };
  },
  'data:automation_create': async ({ runnerId, ownerId, data }) => {
    const type = 'data:automation_create_response';
    const parsed = agentCreateAutomationInput.safeParse({
      name: data.name,
      prompt: data.prompt,
      schedule: data.schedule,
      ...(data.model !== undefined && { model: data.model }),
      ...(data.permissionMode !== undefined && { permissionMode: data.permissionMode }),
    });
    if (!parsed.success) {
      return {
        type,
        error: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid automation fields.',
      };
    }
    const created = await automationAgentTools.create(
      { threadId: String(data.threadId), runnerId, runnerOwnerId: ownerId },
      parsed.data,
    );
    return created.isOk()
      ? { type, automation: created.value }
      : { type, error: created.error.kind, message: created.error.message };
  },
  'data:automation_update': async ({ runnerId, ownerId, data }) => {
    const type = 'data:automation_update_response';
    const parsed = agentUpdateAutomationPatch.safeParse(data.patch);
    if (!parsed.success) {
      return {
        type,
        error: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid automation update fields.',
      };
    }
    const updated = await automationAgentTools.update(
      { threadId: String(data.threadId), runnerId, runnerOwnerId: ownerId },
      String(data.automationId),
      parsed.data,
    );
    return updated.isOk()
      ? { type, automation: updated.value }
      : { type, error: updated.error.kind, message: updated.error.message };
  },
  'data:automation_delete': async ({ runnerId, ownerId, data }) => {
    const type = 'data:automation_delete_response';
    const removed = await automationAgentTools.remove(
      { threadId: String(data.threadId), runnerId, runnerOwnerId: ownerId },
      String(data.automationId),
    );
    return removed.isOk()
      ? { type, ...removed.value }
      : { type, error: removed.error.kind, message: removed.error.message };
  },
  'data:automation_trigger': async ({ runnerId, ownerId, data }) => {
    const type = 'data:automation_trigger_response';
    const triggered = await automationAgentTools.trigger(
      { threadId: String(data.threadId), runnerId, runnerOwnerId: ownerId },
      String(data.automationId),
    );
    return triggered.isOk()
      ? { type, ...triggered.value }
      : { type, error: triggered.error.kind, message: triggered.error.message };
  },
};

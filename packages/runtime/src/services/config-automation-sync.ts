/**
 * @domain subdomain: Automation
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 *
 * Syncs automation definitions from .funny.json into the database.
 * Config-sourced automations get source='config' and are read-only in the UI.
 * Uses an upsert pattern: creates new, updates changed, removes stale.
 */

import { readProjectConfig } from '@funny/core/ports';

import { log } from '../lib/logger.js';
import * as am from './automation-manager.js';

export async function syncConfigAutomations(
  projectId: string,
  projectPath: string,
  userId: string,
): Promise<{ created: number; updated: number; removed: number }> {
  const config = readProjectConfig(projectPath);
  const configAutomations = config?.automations ?? [];

  if (configAutomations.length === 0) {
    return { created: 0, updated: 0, removed: 0 };
  }

  // Get existing config-sourced automations for this project
  const allAutomations = await am.listAutomations(projectId, userId);
  const existing = allAutomations.filter((a: any) => a.source === 'config');
  const existingByName = new Map(existing.map((a: any) => [a.name, a]));
  const configNames = new Set(configAutomations.map((a) => a.name));

  let created = 0;
  let updated = 0;
  let removed = 0;

  // Upsert config automations
  for (const ca of configAutomations) {
    const match = existingByName.get(ca.name);
    if (!match) {
      await am.createAutomation({
        projectId,
        name: ca.name,
        prompt: ca.prompt,
        schedule: ca.schedule,
        model: ca.model,
        permissionMode: ca.permissionMode,
        userId,
        source: 'config',
      });
      created++;
    } else if (
      match.prompt !== ca.prompt ||
      match.schedule !== ca.schedule ||
      (ca.model && match.model !== ca.model)
    ) {
      const updates: Record<string, any> = {
        prompt: ca.prompt,
        schedule: ca.schedule,
      };
      if (ca.model) updates.model = ca.model;
      if (ca.permissionMode) updates.permissionMode = ca.permissionMode;
      await am.updateAutomation(match.id, updates);
      updated++;
    }
  }

  // Remove config automations that are no longer in the file
  for (const [name, automation] of existingByName) {
    if (!configNames.has(name)) {
      await am.deleteAutomation(automation.id);
      removed++;
    }
  }

  log.info(`Config automation sync: ${created} created, ${updated} updated, ${removed} removed`, {
    namespace: 'config-automation-sync',
    projectId,
  });

  return { created, updated, removed };
}

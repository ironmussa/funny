/**
 * Permission rules client (runtime side).
 *
 * The authoritative store for permission rules is the central server's
 * SQLite/PG database. This module is the runtime-side facade callers use
 * to create and query rules — it delegates to the automation/policy client,
 * which uses the shared gRPC data channel to reach the central server.
 *
 * @domain subdomain: Permissions
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { log } from '../lib/logger.js';

export type PermissionDecision = 'allow' | 'deny';

export interface CreatePermissionRuleInput {
  userId: string;
  projectPath: string;
  toolName: string;
  pattern: string | null;
  decision: PermissionDecision;
}

export interface PermissionRuleQuery {
  userId: string;
  projectPath: string;
  toolName: string;
  toolInput?: string;
}

export interface PermissionRule {
  id: string;
  userId: string;
  projectPath: string;
  toolName: string;
  pattern: string | null;
  decision: PermissionDecision;
  createdAt: string;
}

/**
 * Persist an "always allow" / "always deny" decision via the data tunnel.
 * Returns the created rule, or null on transport failure (logged).
 */
export async function createPermissionRule(
  input: CreatePermissionRuleInput,
): Promise<PermissionRule | null> {
  try {
    const { remoteCreatePermissionRule } = await import('./remote-automation-policy-client.js');
    const rule = await remoteCreatePermissionRule(input);
    log.info('permission-rules-client.created', {
      namespace: 'permission-rules-client',
      userId: input.userId,
      projectPath: input.projectPath,
      toolName: input.toolName,
      pattern: input.pattern ?? '',
      decision: input.decision,
    });
    return rule;
  } catch (err) {
    log.warn('createPermissionRule failed', {
      namespace: 'permission-rules-client',
      error: (err as Error)?.message,
    });
    return null;
  }
}

/**
 * Look up a matching permission rule for the given tool invocation.
 * Returns null when no rule matches OR on transport failure (logged).
 */
export async function findPermissionRule(
  query: PermissionRuleQuery,
): Promise<PermissionRule | null> {
  try {
    const { remoteFindPermissionRule } = await import('./remote-automation-policy-client.js');
    const rule = await remoteFindPermissionRule(query);
    return rule ?? null;
  } catch (err) {
    log.warn('findPermissionRule failed', {
      namespace: 'permission-rules-client',
      error: (err as Error)?.message,
    });
    return null;
  }
}

/**
 * List all rules for a user, optionally scoped to a project path. Used at
 * agent start to pre-derive the set of tool names that should bypass
 * permission prompts.
 */
export async function listPermissionRules(query: {
  userId: string;
  projectPath?: string;
}): Promise<PermissionRule[]> {
  try {
    const { remoteListPermissionRules } = await import('./remote-automation-policy-client.js');
    const rules = await remoteListPermissionRules(query);
    return Array.isArray(rules) ? rules : [];
  } catch (err) {
    log.warn('listPermissionRules failed', {
      namespace: 'permission-rules-client',
      error: (err as Error)?.message,
    });
    return [];
  }
}

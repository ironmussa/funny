/**
 * Permission rules service.
 *
 * Persists per-user, per-project tool permission decisions made from the
 * permission approval card ("always allow in this project"). Used by the
 * agent's preToolUseHook to short-circuit subsequent prompts.
 *
 * @domain subdomain: Permissions
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */

import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ResultAsync } from 'neverthrow';

import { db, dbAll, dbRun } from '../db/index.js';
import { permissionRules } from '../db/schema.js';
import { log } from '../lib/logger.js';

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionRule {
  id: string;
  userId: string;
  projectPath: string;
  toolName: string;
  pattern: string | null;
  decision: PermissionDecision;
  createdAt: string;
}

export interface FindMatchInput {
  userId: string;
  projectPath: string;
  toolName: string;
  toolInput?: string;
}

export interface CreateRuleInput {
  userId: string;
  projectPath: string;
  toolName: string;
  pattern?: string | null;
  decision: PermissionDecision;
}

function normalize(row: any): PermissionRule {
  return {
    id: row.id,
    userId: row.userId ?? row.user_id,
    projectPath: row.projectPath ?? row.project_path,
    toolName: row.toolName ?? row.tool_name,
    pattern: row.pattern ?? null,
    decision: (row.decision as PermissionDecision) ?? 'allow',
    createdAt: row.createdAt ?? row.created_at,
  };
}

function ruleMatches(rule: PermissionRule, toolInput: string | undefined): boolean {
  if (rule.pattern === null || rule.pattern === undefined) return true;
  if (toolInput === undefined) return false;
  if (rule.toolName === 'Bash') {
    return toolInput.startsWith(rule.pattern);
  }
  return rule.pattern === toolInput;
}

/**
 * Find the first matching rule for the given tool invocation. Rules are
 * scanned in newest-first order so explicit recent decisions take
 * precedence over older general ones.
 */
export function findMatch(input: FindMatchInput): ResultAsync<PermissionRule | null, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const rows = await dbAll(
        db
          .select()
          .from(permissionRules)
          .where(
            and(
              eq(permissionRules.userId, input.userId),
              eq(permissionRules.projectPath, input.projectPath),
              eq(permissionRules.toolName, input.toolName),
            ),
          )
          .orderBy(desc(permissionRules.createdAt)),
      );
      const rules = rows.map(normalize);
      const match = rules.find((r) => ruleMatches(r, input.toolInput));
      return match ?? null;
    })(),
    (err) => {
      log.error('permission-rules.findMatch failed', {
        namespace: 'permission-rules',
        error: (err as Error)?.message,
        userId: input.userId,
        toolName: input.toolName,
      });
      return err instanceof Error ? err : new Error(String(err));
    },
  );
}

export function createRule(input: CreateRuleInput): ResultAsync<PermissionRule, Error> {
  const entry: PermissionRule = {
    id: nanoid(),
    userId: input.userId,
    projectPath: input.projectPath,
    toolName: input.toolName,
    pattern: input.pattern ?? null,
    decision: input.decision,
    createdAt: new Date().toISOString(),
  };
  return ResultAsync.fromPromise(
    (async () => {
      await dbRun(db.insert(permissionRules).values(entry));
      log.info('permission-rules.created', {
        namespace: 'permission-rules',
        userId: entry.userId,
        projectPath: entry.projectPath,
        toolName: entry.toolName,
        pattern: entry.pattern ?? '',
        decision: entry.decision,
      });
      return entry;
    })(),
    (err) => {
      log.error('permission-rules.create failed', {
        namespace: 'permission-rules',
        error: (err as Error)?.message,
      });
      return err instanceof Error ? err : new Error(String(err));
    },
  );
}

export function listRules(input: {
  userId: string;
  projectPath?: string;
}): ResultAsync<PermissionRule[], Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const where = input.projectPath
        ? and(
            eq(permissionRules.userId, input.userId),
            eq(permissionRules.projectPath, input.projectPath),
          )
        : eq(permissionRules.userId, input.userId);
      const rows = await dbAll(
        db.select().from(permissionRules).where(where).orderBy(desc(permissionRules.createdAt)),
      );
      return rows.map(normalize);
    })(),
    (err) => {
      log.error('permission-rules.list failed', {
        namespace: 'permission-rules',
        error: (err as Error)?.message,
      });
      return err instanceof Error ? err : new Error(String(err));
    },
  );
}

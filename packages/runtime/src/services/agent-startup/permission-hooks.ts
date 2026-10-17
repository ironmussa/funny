import { log } from '../../lib/logger.js';
import type { runSensitivePathBypass as RunSensitivePathBypass } from '../sensitive-path-bypass.js';

type RuleQuery = { toolName: string; toolInput?: string };
type BypassQuery = { toolName: string; toolInput: unknown; cwd?: string };
type BypassExecutor = (query: BypassQuery) => ReturnType<typeof RunSensitivePathBypass>;

/**
 * Build a permission rule lookup bound to this thread's user + project. The
 * hook in core uses it to short-circuit prompts on persisted "always allow /
 * always deny" decisions. Returns null on transport failure so the hook falls
 * through to the interactive prompt. Undefined when the thread has no user.
 */
export function buildPermissionRuleLookup(
  threadId: string,
  userId: string | undefined,
  projectPath: string,
): ((query: RuleQuery) => Promise<{ decision: any } | null>) | undefined {
  if (!userId) return undefined;
  return async (query: RuleQuery) => {
    try {
      const { findPermissionRule } = await import('../permission-rules-client.js');
      const rule = await findPermissionRule({
        userId,
        projectPath,
        toolName: query.toolName,
        toolInput: query.toolInput,
      });
      if (!rule) return null;
      return { decision: rule.decision };
    } catch (err) {
      log.warn('permissionRuleLookup failed', {
        namespace: 'agent',
        threadId,
        toolName: query.toolName,
        error: (err as Error)?.message,
      });
      return null;
    }
  };
}

/**
 * Bypass executor for sensitive-path operations (e.g. ~/.claude/) when the
 * user has saved an "always allow" rule. Performs the file/bash operation
 * directly and returns the synthetic tool_result text the hook surfaces — the
 * SDK's hardcoded sensitive-path block ignores the hook's allow decision, so
 * we have to do the work ourselves.
 */
export function buildBypassExecutor(cwd: string): BypassExecutor {
  return async (query: BypassQuery) => {
    const { runSensitivePathBypass } = await import('../sensitive-path-bypass.js');
    return runSensitivePathBypass({ ...query, cwd: query.cwd ?? cwd });
  };
}

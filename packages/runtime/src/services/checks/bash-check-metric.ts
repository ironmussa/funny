/**
 * How often agents run checks through Bash instead of `funny_run_checks`, and
 * whether Claude's PreToolUse redirect catches them (`checkRedirectReason`).
 * A check it would not catch is logged with its command, so the next shape to
 * cover (`$(find …)`, `| tee`, chains) comes from real calls, not guesses.
 */

import { checkRedirectReason } from '@funny/core/agents';
import { classifyCheckCommand } from '@funny/shared/checks';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';

/** Records a Bash tool call that runs a check; ignores any other tool or command. */
export function recordBashCheck(threadId: string, tool: string, input: unknown): void {
  const command = tool === 'Bash' ? (input as { command?: unknown } | null)?.command : undefined;
  if (typeof command !== 'string') return;
  const check = classifyCheckCommand(command);
  if (!check) return;
  // Redirected only where the hook runs (Claude, project setting on); the
  // attribute says whether its rule matches, so the escapes are visible anywhere.
  const redirectable = checkRedirectReason(command) !== null;
  metric('checks.bash_check', 1, {
    attributes: { kind: check.kind, tool: check.tool, redirectable },
  });
  if (!redirectable) {
    log.info('check run through Bash, not redirectable', {
      namespace: 'checks',
      threadId,
      kind: check.kind,
      tool: check.tool,
      command: command.slice(0, 500),
    });
  }
}

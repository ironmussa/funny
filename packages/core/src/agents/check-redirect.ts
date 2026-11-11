/**
 * The redirect from a raw check command to `funny_run_checks`: Claude's
 * PreToolUse hook denies a Bash call whose WHOLE command is a check (`npx
 * vitest run src/a.test.ts`, `bunx tsc --noEmit`, `cd pkg && bun run lint`)
 * and tells the agent the equivalent tool call. A check inside a pipeline or a
 * longer script runs unchanged: the shell around it may matter.
 */

import { classifyCheckCommand } from '@funny/shared/checks';

export const CHECK_TOOL = 'mcp__funny__funny_run_checks';

/** The deny reason for `command`, or null when it is not a plain check. */
export function checkRedirectReason(command: string): string | null {
  const check = classifyCheckCommand(command);
  if (!check?.plain) return null;
  // A leading `cd` is the scope's base: funny runs in the thread's cwd.
  const scope = check.scope.map((path) => (check.cwd ? `${check.cwd}/${path}` : path));
  const args = {
    kind: check.kind,
    ...(scope.length ? { scope } : check.cwd ? { scope: [check.cwd] } : {}),
    ...(check.filter ? { filter: check.filter } : {}),
  };
  return (
    `Run checks with ${CHECK_TOOL} instead of Bash: it picks the project's ` +
    `command, shows live progress in the thread and returns a short summary. ` +
    `Equivalent call: ${JSON.stringify(args)}. To run this exact command, pass ` +
    `${JSON.stringify({ kind: check.kind, command })}.`
  );
}

/**
 * The redirect from a raw check command to `funny_run_checks`: Claude's
 * PreToolUse hook denies a Bash call whose WHOLE command is a check (`npx
 * vitest run src/a.test.ts`, `bunx tsc --noEmit`, `cd pkg && bun run lint`),
 * or one that is once its output readers (`… 2>&1 | tail -20`) and `$(ls …)`
 * file lists are dropped, and tells the
 * agent the equivalent tool call. A check inside a longer script runs
 * unchanged: the shell around it may matter.
 */

import { classifyCheckCommand } from '@funny/shared/checks';

export const CHECK_TOOL = 'mcp__funny__funny_run_checks';

/** The deny reason for `command`, or null when it is not a plain check. */
export function checkRedirectReason(command: string): string | null {
  const check = classifyCheckCommand(command);
  if (!check || (!check.plain && !check.simplified)) return null;
  const exact = check.simplified?.checkCommand ?? command;
  const tail = check.simplified
    ? ' No need to trim its output (the summary is already short) or to list ' +
      'files with $(ls …): globs work as they are.'
    : '';
  const intro =
    `Run checks with ${CHECK_TOOL} instead of Bash: it shows live progress in ` +
    `the thread and returns a short summary.`;
  // After a `cd`, the command is the call: funny picks a tool for the
  // thread's directory, which in a monorepo is not the package's (the root
  // may run playwright where the package runs vitest).
  if (check.cwd) {
    return `${intro} Call it with ${JSON.stringify({ kind: check.kind, command: exact })}.${tail}`;
  }
  const args = {
    kind: check.kind,
    ...(check.scope.length ? { scope: check.scope } : {}),
    ...(check.filter ? { filter: check.filter } : {}),
  };
  return (
    `${intro} Equivalent call (funny picks the project's command): ${JSON.stringify(args)}. To run ` +
    `this exact command, pass ${JSON.stringify({ kind: check.kind, command: exact })}.${tail}`
  );
}

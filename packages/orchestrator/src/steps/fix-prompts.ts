/**
 * The prompts of the `fix` step. They resume the run's agent session, so they
 * say only what changed: CI failed, or the base moved.
 */

import type { FailingCheck, FixStepSpec } from './fix.js';

const UNATTENDED = `You are working unattended: nobody will answer questions, so make
reasonable decisions and state them in your final message.`;

const finish = (spec: FixStepSpec) =>
  [
    `- Stay on the branch \`${spec.branch}\`.`,
    spec.checkCommand
      ? `- Run the project's checks before you finish: \`${spec.checkCommand}\`.`
      : '',
    '- Do not push: that happens after you finish. Committing is fine.',
    '- End with a short summary of what you changed and why.',
  ]
    .filter(Boolean)
    .join('\n');

export function checksPrompt(spec: FixStepSpec, checks: FailingCheck[]): string {
  const listed = checks
    .map((c) => `### ${c.name} (${c.conclusion})\n\n\`\`\`\n${c.excerpt}\n\`\`\``)
    .join('\n\n');
  return `${UNATTENDED}

CI failed on your pull request for issue #${spec.issue.number} (${spec.prUrl}).

Failing checks:

${listed}

Fix the cause in the code. Do not disable, skip or weaken checks or tests.

${finish(spec)}`;
}

export function conflictPrompt(spec: FixStepSpec): string {
  return `${UNATTENDED}

Your pull request for issue #${spec.issue.number} (${spec.prUrl}) conflicts with \`${spec.base}\`,
which has moved on. \`origin/${spec.base}\` has just been fetched.

Rebase the branch onto it: \`git rebase origin/${spec.base}\`. Resolve every conflict keeping
both the intent of the issue and the changes on \`${spec.base}\`, then \`git add\` the
files and \`git rebase --continue\` until the rebase is done.

${finish(spec)}`;
}

export function localChecksPrompt(command: string, error: string): string {
  return `The checks (\`${command}\`) failed after your fix:

\`\`\`
${error}
\`\`\`

Fix the cause in the code (do not disable or skip checks), then stop.
The checks run again after you finish.`;
}

/**
 * The body of a factory run's pull request.
 */

export function buildPullRequestBody(input: {
  issueNumber: number;
  checkCommand?: string;
}): string {
  const checks = input.checkCommand
    ? `Local checks passed: \`${input.checkCommand}\`.`
    : 'No local checks ran: this project has no check command configured.';
  return [
    `Opened by the issue factory for #${input.issueNumber}.`,
    '',
    checks,
    '',
    `Closes #${input.issueNumber}`,
  ].join('\n');
}

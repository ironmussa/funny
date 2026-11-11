import { describe, expect, test } from 'vitest';

import { CHECK_TOOL, checkRedirectReason } from '../agents/check-redirect.js';
import { SDKClaudeProcess } from '../agents/sdk-claude.js';

describe('checkRedirectReason', () => {
  test('a plain vitest call points at the tool with its scope and filter', () => {
    const reason = checkRedirectReason('npx vitest run src/a.test.ts -t "parses dates"')!;
    expect(reason).toContain(CHECK_TOOL);
    expect(reason).toContain('{"kind":"test","scope":["src/a.test.ts"],"filter":"parses dates"}');
    expect(reason).toContain('"command":"npx vitest run src/a.test.ts -t \\"parses dates\\""');
  });

  test('a leading cd becomes the scope base', () => {
    expect(checkRedirectReason('cd packages/client && npx vitest run src/a.test.ts')).toContain(
      '"scope":["packages/client/src/a.test.ts"]',
    );
    expect(checkRedirectReason('cd packages/client && bun run typecheck')).toContain(
      '{"kind":"typecheck","scope":["packages/client"]}',
    );
  });

  test.each([
    'bunx tsc --noEmit 2>&1 | rg "error TS"',
    'bun run lint && bun run typecheck',
    'npx vitest run > /tmp/out.log',
    'git status',
    'cat package.json',
  ])('%s runs unchanged', (command) => {
    expect(checkRedirectReason(command)).toBeNull();
  });
});

describe('SDKClaudeProcess PreToolUse redirect', () => {
  const hook = (redirectChecks: boolean, toolName: string, command: string) =>
    (new SDKClaudeProcess({ prompt: 'hi', cwd: '/tmp', redirectChecks }) as any).preToolUseHook(
      { tool_name: toolName, tool_input: { command } },
      'toolu_1',
      { signal: new AbortController().signal },
    );

  test('denies a plain check with the redirect reason when the setting is on', async () => {
    const result = await hook(true, 'Bash', 'npx vitest run');
    expect(result.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining(CHECK_TOOL),
    });
  });

  test('lets it through when the setting is off', async () => {
    const result = await hook(false, 'Bash', 'npx vitest run');
    expect(result?.hookSpecificOutput?.permissionDecisionReason ?? '').not.toContain(CHECK_TOOL);
  });

  test('never touches other tools or compound commands', async () => {
    for (const [tool, command] of [
      ['Bash', 'npx vitest run 2>&1 | tail -20'],
      ['Read', 'npx vitest run'],
    ]) {
      const result = await hook(true, tool, command);
      expect(result?.hookSpecificOutput?.permissionDecisionReason ?? '').not.toContain(CHECK_TOOL);
    }
  });
});

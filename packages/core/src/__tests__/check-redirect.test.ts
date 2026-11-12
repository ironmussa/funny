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

  test('after a cd, the exact command is the call (the package may use another tool)', () => {
    const reason = checkRedirectReason('cd packages/client && npx vitest run src/a.test.ts')!;
    expect(reason).toContain(
      '{"kind":"test","command":"cd packages/client && npx vitest run src/a.test.ts"}',
    );
    expect(reason).not.toContain('"scope"');
  });

  test('a check that only trims its output is redirected without the readers', () => {
    const reason = checkRedirectReason(
      'cd packages/server && bun test src/a.test.ts 2>&1 | tail -20',
    )!;
    expect(reason).toContain('"command":"cd packages/server && bun test src/a.test.ts 2>&1"');
    expect(reason).toContain('No need to trim');
    expect(checkRedirectReason('npx vitest run src/a.test.ts | tail')).toContain(
      '{"kind":"test","scope":["src/a.test.ts"]}',
    );
  });

  test.each([
    'bun test $(find src -name "*.test.ts") 2>&1 | grep pass',
    'npx vitest run | tee out.log',
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
      ['Bash', 'npx vitest run 2>&1 | tee out.log'],
      ['Read', 'npx vitest run'],
    ]) {
      const result = await hook(true, tool, command);
      expect(result?.hookSpecificOutput?.permissionDecisionReason ?? '').not.toContain(CHECK_TOOL);
    }
  });
});

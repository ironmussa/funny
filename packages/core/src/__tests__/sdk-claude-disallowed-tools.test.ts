import { describe, test, expect } from 'vitest';

import {
  FUNNY_DEAD_CLAUDE_TOOLS,
  mcpAutoAllowWildcards,
  mergeDisallowedTools,
} from '../agents/sdk-claude.js';

// Regression: ScheduleWakeup is a no-op inside funny's SDK/headless runtime —
// its firing relies on the interactive CLI's outer loop, which doesn't exist
// here, so a scheduled wake never re-invokes the thread. We hard-disallow it
// so the model uses the durable funny_watch path instead. See
// agent-watcher-manager.ts for the working equivalent.
describe('mergeDisallowedTools', () => {
  test('always disallows ScheduleWakeup, even with no caller list', () => {
    expect(FUNNY_DEAD_CLAUDE_TOOLS).toContain('ScheduleWakeup');
    expect(mergeDisallowedTools()).toContain('ScheduleWakeup');
    expect(mergeDisallowedTools(undefined)).toContain('ScheduleWakeup');
    expect(mergeDisallowedTools([])).toContain('ScheduleWakeup');
  });

  test('preserves caller-supplied disallowed tools', () => {
    const merged = mergeDisallowedTools(['Bash', 'WebFetch']);
    expect(merged).toContain('ScheduleWakeup');
    expect(merged).toContain('Bash');
    expect(merged).toContain('WebFetch');
  });

  test('dedupes when the caller already lists a dead tool', () => {
    const merged = mergeDisallowedTools(['ScheduleWakeup', 'Bash']);
    expect(merged.filter((t) => t === 'ScheduleWakeup')).toHaveLength(1);
    expect(merged).toContain('Bash');
  });
});

// Browser tools act on real, often logged-in pages: they must follow the
// thread's permission mode rather than the blanket MCP auto-allow.
describe('mcpAutoAllowWildcards', () => {
  test('auto-allows ordinary MCP servers', () => {
    expect(mcpAutoAllowWildcards(['funny', 'linear'])).toEqual(['mcp__funny__*', 'mcp__linear__*']);
  });

  test('never auto-allows the funny_browser server', () => {
    expect(mcpAutoAllowWildcards(['funny', 'funny_browser'])).toEqual(['mcp__funny__*']);
  });
});

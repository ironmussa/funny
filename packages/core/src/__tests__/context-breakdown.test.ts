import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';

import { toContextBreakdown } from '../agents/context-breakdown.js';

function usage(
  overrides: Partial<SDKControlGetContextUsageResponse> = {},
): SDKControlGetContextUsageResponse {
  return {
    categories: [
      { id: 'messages', name: 'Messages', tokens: 377_600, color: 'blue', kind: 'used' },
      { id: 'free_space', name: 'Free space', tokens: 500_000, color: 'grey', kind: 'free' },
      {
        id: 'mcp_tools_deferred',
        name: 'MCP tools (deferred)',
        tokens: 46_700,
        color: 'grey',
        isDeferred: true,
        kind: 'deferred',
      },
    ],
    totalTokens: 466_400,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 47,
    gridRows: [],
    model: 'claude-opus-5-5',
    memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 9_000 }],
    mcpTools: [
      { name: 'mcp__fallow__audit', serverName: 'fallow', tokens: 1_000 },
      { name: 'mcp__funny__watch', serverName: 'funny', tokens: 5_000 },
      { name: 'mcp__fallow__trace', serverName: 'fallow', tokens: 3_000 },
    ],
    agents: [],
    ...overrides,
  } as SDKControlGetContextUsageResponse;
}

describe('toContextBreakdown', () => {
  test('keeps totals and category kinds, dropping render-only fields', () => {
    const at = new Date('2026-11-09T10:00:00.000Z');
    const b = toContextBreakdown(usage(), at);

    expect(b).toMatchObject({
      model: 'claude-opus-5-5',
      totalTokens: 466_400,
      maxTokens: 1_000_000,
      percentage: 47,
      capturedAt: '2026-11-09T10:00:00.000Z',
    });
    expect(b.categories).toEqual([
      { id: 'messages', name: 'Messages', tokens: 377_600, kind: 'used' },
      { id: 'free_space', name: 'Free space', tokens: 500_000, kind: 'free' },
      { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 46_700, kind: 'deferred' },
    ]);
    expect(b.memoryFiles).toEqual([{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 9_000 }]);
  });

  test('aggregates MCP tools per server, largest first', () => {
    expect(toContextBreakdown(usage()).mcpServers).toEqual([
      { name: 'funny', tools: 1, tokens: 5_000 },
      { name: 'fallow', tools: 2, tokens: 4_000 },
    ]);
  });

  test('omits the row id when an older CLI does not send it', () => {
    const b = toContextBreakdown(
      usage({ categories: [{ name: 'Messages', tokens: 10, color: 'blue', kind: 'used' }] }),
    );
    expect(b.categories).toEqual([{ name: 'Messages', tokens: 10, kind: 'used' }]);
  });
});

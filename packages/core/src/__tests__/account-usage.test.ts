import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';

import { toAgentAccountInfo, toAgentPlanUsage } from '../agents/account-usage.js';

function usage(
  rateLimits: SDKControlGetUsageResponse['rate_limits'],
  available = true,
): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: available,
    rate_limits: rateLimits,
    behaviors: null,
  } as SDKControlGetUsageResponse;
}

describe('toAgentPlanUsage', () => {
  test('maps the plan windows in display order, then per-model ones', () => {
    const res = toAgentPlanUsage(
      usage({
        seven_day: { utilization: 18, resets_at: '2026-11-24T10:00:00Z' },
        five_hour: { utilization: 42.5, resets_at: '2026-11-21T15:00:00Z' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }],
      }),
    );
    expect(res?.windows).toEqual([
      { key: 'five_hour', utilization: 42.5, resetsAt: '2026-11-21T15:00:00Z' },
      { key: 'seven_day', utilization: 18, resetsAt: '2026-11-24T10:00:00Z' },
      { key: 'model:Fable', label: 'Fable', utilization: 3, resetsAt: null },
    ]);
    expect(res?.extraUsage).toBeUndefined();
  });

  test('skips windows the endpoint knows nothing about', () => {
    const res = toAgentPlanUsage(
      usage({ five_hour: { utilization: null, resets_at: null }, seven_day: undefined }),
    );
    expect(res?.windows).toEqual([]);
  });

  test('keeps extra usage only when enabled', () => {
    const res = toAgentPlanUsage(
      usage({
        extra_usage: {
          is_enabled: true,
          monthly_limit: 50,
          used_credits: 12,
          utilization: 24,
          currency: 'USD',
        },
      }),
    );
    expect(res?.extraUsage).toEqual({
      usedCredits: 12,
      monthlyLimit: 50,
      utilization: 24,
      currency: 'USD',
    });
    const off = toAgentPlanUsage(
      usage({
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      }),
    );
    expect(off?.extraUsage).toBeUndefined();
  });

  test('is undefined when plan limits do not apply', () => {
    expect(toAgentPlanUsage(usage(null, false))).toBeUndefined();
  });
});

describe('toAgentAccountInfo', () => {
  test('drops the token and key sources', () => {
    expect(
      toAgentAccountInfo({
        email: 'a@b.c',
        organization: 'Org',
        subscriptionType: 'max',
        tokenSource: 'oauth',
        apiKeySource: 'none',
        apiProvider: 'firstParty',
      }),
    ).toEqual({
      email: 'a@b.c',
      organization: 'Org',
      subscriptionType: 'max',
      apiProvider: 'firstParty',
    });
  });
});

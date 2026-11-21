import type { AccountInfo, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAccountInfo, AgentPlanUsage, AgentPlanUsageWindow } from '@funny/shared';

/** The fixed plan windows of `/usage`, in display order. */
const PLAN_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const;

/** Keep only the account fields the client shows (no token / key sources). */
export function toAgentAccountInfo(info: AccountInfo): AgentAccountInfo {
  return {
    email: info.email,
    organization: info.organization,
    subscriptionType: info.subscriptionType,
    apiProvider: info.apiProvider,
  };
}

/**
 * Map the Claude Agent SDK's `/usage` response to the provider-neutral
 * {@link AgentPlanUsage} carried on `agent:account`. Session totals and the
 * local-transcript behaviors are dropped: only the account's plan windows
 * matter here. Undefined when plan limits do not apply (API key, Bedrock, …).
 */
export function toAgentPlanUsage(res: SDKControlGetUsageResponse): AgentPlanUsage | undefined {
  const limits = res.rate_limits;
  if (!res.rate_limits_available || !limits) return undefined;

  const windows: AgentPlanUsageWindow[] = [];
  for (const key of PLAN_WINDOWS) {
    const w = limits[key];
    if (w && (w.utilization !== null || w.resets_at !== null)) {
      windows.push({ key, utilization: w.utilization, resetsAt: w.resets_at });
    }
  }
  for (const w of limits.model_scoped ?? []) {
    windows.push({
      key: `model:${w.display_name}`,
      label: w.display_name,
      utilization: w.utilization,
      resetsAt: w.resets_at,
    });
  }

  const result: AgentPlanUsage = { windows };
  const extra = limits.extra_usage;
  if (extra?.is_enabled) {
    result.extraUsage = {
      usedCredits: extra.used_credits,
      monthlyLimit: extra.monthly_limit,
      utilization: extra.utilization,
      currency: extra.currency,
    };
  }
  return result;
}

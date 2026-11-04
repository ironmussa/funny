import { GATEABLE_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { useMemo } from 'react';

import { useRunnerProviders } from '@/data/runner/hooks';
import type { AdvertisedProvider } from '@/lib/api/system';

import type { ModelGroup } from './use-acp-prompt-models';

/** Built-in ACP providers that lean-core can gate off (claude/deepagent/llm-api stay). */
const BUILTIN_ACP = new Set<string>(GATEABLE_ACP_PROVIDER_IDS);

/** The runner-advertised provider state the picker reconciles against. */
export interface RunnerProviderState {
  providers: AdvertisedProvider[];
  activeBuiltins: string[] | null;
  availableProviders: string[] | null;
  hasRunner: boolean;
}

/**
 * Pure reconciliation of the base picker groups against the runner state:
 * lean-core gating (hide), external append, and availability greying. Extracted
 * from the hook so it's unit-testable without React/the store.
 */
export function applyRunnerProviderGroups(
  baseGroups: ModelGroup[],
  state: RunnerProviderState,
): ModelGroup[] {
  const { providers, activeBuiltins, availableProviders, hasRunner } = state;

  // 1. Hide gated-off built-in ACP providers (lean-core).
  const activeSet = activeBuiltins ? new Set(activeBuiltins) : null;
  const visible = activeSet
    ? baseGroups.filter((g) => !BUILTIN_ACP.has(g.provider) || activeSet.has(g.provider))
    : baseGroups;

  // 2. Append the runner's external providers.
  const existing = new Set(visible.map((g) => g.provider));
  const extra: ModelGroup[] = providers.flatMap((p) => {
    if (existing.has(p.id)) return [];
    const models =
      p.models.kind === 'static' && p.models.entries && p.models.entries.length > 0
        ? p.models.entries.map((e) => ({ value: `${p.id}:${e.id}`, label: e.label }))
        : [
            {
              value: `${p.id}:${p.models.defaultModel}`,
              label: `${p.label} (configured default)`,
            },
          ];
    return [{ provider: p.id, providerLabel: p.label, models }];
  });
  const shown = extra.length > 0 ? [...visible, ...extra] : visible;

  // 3. Availability: grey out (don't remove) providers that cannot run.
  if (!hasRunner) return shown.map((g) => markDisabled(g, 'no-runner'));
  if (!availableProviders) return shown; // online but unknown → don't gate
  const availSet = new Set(availableProviders);
  return shown.map((g) => (availSet.has(g.provider) ? g : markDisabled(g, 'not-installed')));
}

/**
 * Providers a sandbox agent can use: the server's LLM proxy holds a credential
 * only for these (thread-sandboxes). Keep in sync with the proxy adapters.
 */
const SANDBOX_PROVIDERS = new Set(['claude']);

/**
 * Picker groups for a thread that runs in a sandbox. The user's own runners do
 * not matter there: supported providers are enabled even with every runner
 * offline, and the rest are greyed out as not available in sandboxes yet.
 */
export function applySandboxModelGroups<
  G extends Pick<ModelGroup, 'provider' | 'models' | 'disabled' | 'disabledReason'>,
>(groups: G[]): G[] {
  return groups.map((g) => {
    const supported = SANDBOX_PROVIDERS.has(g.provider);
    return {
      ...g,
      disabled: !supported,
      disabledReason: supported ? undefined : 'sandbox-unsupported',
      models: g.models.map((m) => ({ ...m, disabled: !supported })),
    };
  });
}

/** Tag a group (and its models) as disabled with a reason, so the picker greys
 *  it out without removing it (model-picker-availability §4). */
function markDisabled(
  g: ModelGroup,
  reason: NonNullable<ModelGroup['disabledReason']>,
): ModelGroup {
  return {
    ...g,
    disabled: true,
    disabledReason: reason,
    models: g.models.map((m) => ({ ...m, disabled: true })),
  };
}

/**
 * Reconciles the model picker with the user's runner:
 *  - hides built-in ACP providers the runner has gated off (lean-core) — only
 *    when the runner advertises an active set (`activeBuiltins != null`);
 *  - appends the runner-installed external providers (provider-manifest-loader);
 *  - greys out active providers that cannot run (model-picker-availability):
 *    no runner connected → everything greyed ("connect a runner"); runner online
 *    but a provider's CLI is missing → that provider greyed ("not installed").
 *    Unknown availability (`availableProviders == null` while a runner is online,
 *    e.g. an older runner) does NOT gate — no regression.
 */
export function useRunnerProviderGroups(baseGroups: ModelGroup[]): ModelGroup[] {
  const { providers, activeBuiltins, availableProviders, hasRunner } = useRunnerProviders();

  return useMemo(
    () =>
      applyRunnerProviderGroups(baseGroups, {
        providers,
        activeBuiltins,
        availableProviders,
        hasRunner,
      }),
    [baseGroups, providers, activeBuiltins, availableProviders, hasRunner],
  );
}

import { BUILTIN_AGENT_TEMPLATES, type AgentTemplate } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, ResultAsync } from 'neverthrow';

import { agentTemplatesApi } from '@/lib/api/agent-templates';

import type { DataLayer } from '../data-layer';
import { toDomainError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { getTemplatesData } from './store';

const TEMPLATES_KEY = ['agent-templates'] as const;
export const TEMPLATE_USAGE_KEY = ['agent-templates', 'usage'] as const;

function fetchTemplates(layer: DataLayer, staleTime: number) {
  const data = getTemplatesData(layer);
  return ResultAsync.fromPromise(
    layer.queryClient.fetchQuery({
      queryKey: TEMPLATES_KEY,
      staleTime,
      queryFn: async () => {
        const own = await unwrapResult(agentTemplatesApi.listAgentTemplates());
        const rows: AgentTemplate[] = [...own, ...BUILTIN_AGENT_TEMPLATES];
        data.position.clear();
        rows.forEach((t, i) => data.position.set(t.id, i));
        data.replaceAll(rows);
        data.loaded = true;
        return rows;
      },
    }),
    toDomainError,
  );
}

/** Load the template list (user templates first, built-ins last) and make it the synced set. */
export function loadTemplates(
  layer: DataLayer = getDataLayer(),
): ResultAsync<AgentTemplate[], DomainError> {
  return fetchTemplates(layer, 0);
}

/** Load the list unless this session already has it (a load in flight is shared). */
export function ensureTemplatesLoaded(
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  if (getTemplatesData(layer).loaded) return okAsync(undefined);
  return fetchTemplates(layer, Number.POSITIVE_INFINITY);
}

/** Query function for the per-template thread counts (`useTemplateUsageStats`). */
export function fetchTemplateUsage(): Promise<Record<string, number>> {
  return unwrapResult(agentTemplatesApi.getAgentTemplateUsageStats());
}

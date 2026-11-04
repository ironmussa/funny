import type { AgentTemplate } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer, useDataQuery } from '../hooks';
import { fetchTemplateUsage, TEMPLATE_USAGE_KEY } from './loaders';
import { compareTemplates, getTemplatesData } from './store';

/** React read API for agent templates (live queries over the templates collection). */

const NO_TEMPLATES: AgentTemplate[] = [];
const NO_USAGE: Record<string, number> = {};

/** Every template of the session, in list order (built-ins last). */
export function useAgentTemplates(): AgentTemplate[] {
  const data = getTemplatesData(useDataLayer());
  const { data: rows } = useLiveQuery((q) => q.from({ template: data.collection }));
  return useMemo(() => {
    if (!rows || rows.length === 0) return NO_TEMPLATES;
    return rows.map((row) => data.fromRow(row as AgentTemplate)).sort(compareTemplates(data));
  }, [rows, data]);
}

export function useAgentTemplate(templateId: string | null | undefined): AgentTemplate | undefined {
  const data = getTemplatesData(useDataLayer());
  const id = templateId ?? '';
  const { data: rows } = useLiveQuery((q) =>
    q.from({ template: data.collection }).where(({ template }) => eq(template.id, id)),
  );
  const row = rows?.[0] as AgentTemplate | undefined;
  return useMemo(() => (row ? data.fromRow(row) : undefined), [row, data]);
}

/** Number of threads started from each template, keyed by template id. */
export function useTemplateUsageStats(): Record<string, number> {
  const { data } = useDataQuery({ queryKey: TEMPLATE_USAGE_KEY, queryFn: fetchTemplateUsage });
  return data ?? NO_USAGE;
}

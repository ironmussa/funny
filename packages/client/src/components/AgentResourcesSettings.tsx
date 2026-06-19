import type { AgentResource, AgentResourceKind } from '@funny/shared';
import { Server, Sparkles, SlashSquare, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { colorFromName } from '@/components/ui/project-chip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

// Bundled providers, in display order. Mirrors the shared descriptor map; kept
// inline so this view does not depend on the runtime registry.
const PROVIDERS: Array<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'opencode' },
  { id: 'pi', label: 'Pi' },
  { id: 'deepagent', label: 'DeepAgent' },
];

const KIND_META: Record<AgentResourceKind, { label: string; icon: typeof Sparkles }> = {
  skill: { label: 'Skills', icon: Sparkles },
  'slash-command': { label: 'Slash Commands', icon: SlashSquare },
  'mcp-server': { label: 'MCP Servers', icon: Server },
  plugin: { label: 'Plugins', icon: Sparkles },
  connector: { label: 'Connectors', icon: Server },
  'builtin-tool': { label: 'Built-in Tools', icon: Sparkles },
  template: { label: 'Templates', icon: Sparkles },
};

const KIND_ORDER: AgentResourceKind[] = [
  'skill',
  'slash-command',
  'mcp-server',
  'plugin',
  'connector',
  'builtin-tool',
  'template',
];

function ResourceRow({ resource, dimmed }: { resource: AgentResource; dimmed?: boolean }) {
  return (
    <div
      className={cn(
        'border-border/50 bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2',
        dimmed && 'opacity-60',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: colorFromName(resource.name) }}
      data-testid={`agent-resource-${resource.kind}-${resource.name}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">
            {resource.kind === 'slash-command' ? `/${resource.name}` : resource.name}
          </span>
          {resource.commandTier && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
              {resource.commandTier}
            </span>
          )}
        </div>
        {resource.description && (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{resource.description}</p>
        )}
        <span className="text-muted-foreground/70 text-xs">{resource.origin}</span>
      </div>
      {dimmed && resource.hiddenReason && (
        <span className="text-muted-foreground/70 inline-flex shrink-0 items-center gap-1 text-xs">
          <EyeOff className="icon-2xs" />
          {resource.hiddenReason}
        </span>
      )}
    </div>
  );
}

export function AgentResourcesSettings() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);

  const [provider, setProvider] = useState<string>('claude');
  const [resources, setResources] = useState<AgentResource[]>([]);
  const [hidden, setHidden] = useState<AgentResource[]>([]);
  const [loading, setLoading] = useState(false);

  const projectPath = selectedProjectId
    ? (projects.find((p) => p.id === selectedProjectId)?.path ?? undefined)
    : (projects[0]?.path ?? undefined);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.listAgentResources({ projectPath, provider, phase: 'settings' });
    if (result.isOk()) {
      setResources(result.value.resources);
      setHidden(result.value.hidden);
    } else {
      toastError(result.error);
      setResources([]);
      setHidden([]);
    }
    setLoading(false);
  }, [projectPath, provider]);

  useEffect(() => {
    load();
  }, [load]);

  const byKind = useMemo(() => {
    const map = new Map<AgentResourceKind, AgentResource[]>();
    for (const r of resources) {
      const arr = map.get(r.kind) ?? [];
      arr.push(r);
      map.set(r.kind, arr);
    }
    return map;
  }, [resources]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{t('settings.agentResources')}</h2>
          <p className="text-muted-foreground text-xs">{t('agentResources.subtitle')}</p>
        </div>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="w-44" data-testid="agent-resources-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.id} value={p.id} data-testid={`agent-resources-provider-${p.id}`}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <LoadingState
          fill={false}
          layout="inline"
          className="py-6"
          testId="agent-resources-loading"
          label={t('common.loading')}
        />
      ) : (
        <>
          {KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => {
            const Icon = KIND_META[kind].icon;
            const items = byKind.get(kind)!;
            return (
              <div key={kind}>
                <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
                  <Icon className="icon-xs" />
                  {KIND_META[kind].label}
                </h3>
                <div className="space-y-1.5">
                  {items.map((r, i) => (
                    <ResourceRow key={`${r.kind}-${r.name}-${i}`} resource={r} />
                  ))}
                </div>
              </div>
            );
          })}

          {resources.length === 0 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              {t('agentResources.empty')}
            </div>
          )}

          {/* Incompatible resources — shown for audit only; not suggested or injected. */}
          {hidden.length > 0 && (
            <div data-testid="agent-resources-incompatible">
              <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
                <EyeOff className="icon-xs" />
                {t('agentResources.incompatible')}
              </h3>
              <div className="space-y-1.5">
                {hidden.map((r, i) => (
                  <ResourceRow key={`hidden-${r.kind}-${r.name}-${i}`} resource={r} dimmed />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

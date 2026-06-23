import type { McpServer } from '@funny/shared';
import { Loader2, Plug, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

import { isVisibleMcpServer } from './available-mcp-servers-utils';

interface AvailableMcpServersProps {
  projectPath?: string;
  projectId?: string;
  provider?: string;
  className?: string;
}

function mcpSettingsPath(projectId?: string): string {
  return projectId
    ? buildPath(`/projects/${projectId}/settings/mcp-server`)
    : buildPath('/settings/mcp-server');
}

const MCP_TRANSPORT_FALLBACK: Record<McpServer['type'], string> = {
  stdio: 'Local command',
  http: 'Remote HTTP',
  sse: 'Streaming SSE',
};

const MCP_SOURCE_FALLBACK: Record<NonNullable<McpServer['source']>, string> = {
  project: 'Project',
  user: 'User',
};

function getMcpEndpoint(server: McpServer): string | null {
  if (server.url) return server.url;
  if (server.command) return [server.command, ...(server.args ?? [])].join(' ');
  return null;
}

export function AvailableMcpServers({
  projectPath,
  projectId,
  provider = 'claude',
  className,
}: AvailableMcpServersProps) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const prevLoadKeyRef = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!projectPath) {
      setServers([]);
      return;
    }
    setLoading(true);
    const result = await api.listMcpServers(projectPath, provider);
    setServers(result.isOk() ? result.value.servers : []);
    setLoading(false);
  }, [projectPath, provider]);

  useEffect(() => {
    const loadKey = projectPath ? `${projectPath}:${provider}` : undefined;
    if (loadKey === prevLoadKeyRef.current) return;
    prevLoadKeyRef.current = loadKey;
    void load();
  }, [projectPath, provider, load]);

  if (!projectPath) return null;

  const visibleServers = servers.filter(isVisibleMcpServer);

  return (
    <div
      className={cn(
        'mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground',
        className,
      )}
      data-testid="available-mcp-servers"
    >
      <Link
        to={mcpSettingsPath(projectId)}
        className="hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors"
        data-testid="available-mcp-settings-link"
        aria-label={t('newThread.configureMcp')}
      >
        <Plug className="size-3.5" />
        <span>{t('newThread.availableMcp')}</span>
      </Link>
      {loading ? (
        <Loader2 className="icon-xs animate-spin" data-testid="available-mcp-loading" />
      ) : visibleServers.length === 0 ? (
        <span className="text-muted-foreground/60" data-testid="available-mcp-empty">
          {t('newThread.noMcpServers')}
        </span>
      ) : (
        visibleServers.map((server) => {
          const needsAuth = server.status === 'needs_auth';
          const endpoint = getMcpEndpoint(server);
          const transportLabel = t(
            `mcp.transport.${server.type}`,
            MCP_TRANSPORT_FALLBACK[server.type],
          );
          const sourceLabel = server.source
            ? t(`mcp.source.${server.source}`, MCP_SOURCE_FALLBACK[server.source])
            : t('mcp.source.unknown', 'Unknown');
          const statusLabel = needsAuth ? t('mcp.needsAuth') : t('mcp.status.ready', 'Ready');

          return (
            <Tooltip key={server.name}>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  size="xs"
                  data-testid={`available-mcp-${server.name}`}
                  aria-label={needsAuth ? `${server.name}: ${t('mcp.needsAuth')}` : server.name}
                  className={cn(needsAuth && 'border-amber-500/50 bg-amber-500/10 text-amber-300')}
                >
                  {needsAuth && <ShieldAlert aria-hidden="true" />}
                  {server.name}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="w-72 p-3 text-left">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate font-medium text-gray-950">{server.name}</p>
                  <span className="shrink-0 rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] leading-none text-gray-600 uppercase">
                    {server.type}
                  </span>
                </div>
                <dl className="mt-2 space-y-1.5">
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-gray-500">{t('mcp.tooltip.transport', 'Transport')}</dt>
                    <dd className="truncate text-gray-900">{transportLabel}</dd>
                  </div>
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-gray-500">{t('mcp.tooltip.scope', 'Scope')}</dt>
                    <dd className="truncate text-gray-900">{sourceLabel}</dd>
                  </div>
                  {endpoint && (
                    <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                      <dt className="text-gray-500">
                        {server.url
                          ? t('mcp.tooltip.endpoint', 'Endpoint')
                          : t('mcp.tooltip.command', 'Command')}
                      </dt>
                      <dd className="truncate font-mono text-[11px] text-gray-900">{endpoint}</dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-gray-500">{t('mcp.tooltip.status', 'Status')}</dt>
                    <dd className={cn('truncate text-gray-900', needsAuth && 'text-amber-700')}>
                      {statusLabel}
                    </dd>
                  </div>
                </dl>
                {needsAuth && (
                  <div className="mt-2 rounded border border-amber-500/30 bg-amber-50 px-2 py-1.5">
                    <p className="text-amber-800">{t('mcp.authHint')}</p>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })
      )}
    </div>
  );
}

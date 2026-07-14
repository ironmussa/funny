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
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (requestSeq: number) => {
      if (!projectPath) {
        if (requestSeq === requestSeqRef.current) setServers([]);
        return;
      }
      const result = await api.listMcpServers(projectPath, provider, projectId);
      if (requestSeq !== requestSeqRef.current) return;
      setServers(result.isOk() ? result.value.servers : []);
      setLoading(false);
    },
    [projectPath, projectId, provider],
  );

  useEffect(() => {
    const loadKey = projectPath ? `${projectPath}:${provider}:${projectId ?? ''}` : undefined;
    if (loadKey === prevLoadKeyRef.current) return;
    prevLoadKeyRef.current = loadKey;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(Boolean(projectPath));
    // Listing MCP servers makes the runner shell out to the provider CLI (~seconds)
    // and is purely informational chrome below the composer — not needed for the
    // thread to be usable. Defer to idle so it doesn't hold a socket while the
    // on-screen thread is still loading its messages.
    let idleId: number | undefined;
    if (typeof requestIdleCallback === 'function') {
      idleId = requestIdleCallback(() => void load(requestSeq), { timeout: 4000 });
    } else {
      idleId = window.setTimeout(() => void load(requestSeq), 500);
    }
    return () => {
      if (idleId === undefined) return;
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
      if (prevLoadKeyRef.current === loadKey) {
        prevLoadKeyRef.current = undefined;
      }
    };
  }, [projectPath, provider, projectId, load]);

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
                  <p className="text-foreground min-w-0 truncate font-medium">{server.name}</p>
                  <span className="border-border bg-muted text-muted-foreground shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none uppercase">
                    {server.type}
                  </span>
                </div>
                <dl className="mt-2 space-y-1.5">
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-muted-foreground">
                      {t('mcp.tooltip.transport', 'Transport')}
                    </dt>
                    <dd className="text-foreground truncate">{transportLabel}</dd>
                  </div>
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-muted-foreground">{t('mcp.tooltip.scope', 'Scope')}</dt>
                    <dd className="text-foreground truncate">{sourceLabel}</dd>
                  </div>
                  {endpoint && (
                    <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                      <dt className="text-muted-foreground">
                        {server.url
                          ? t('mcp.tooltip.endpoint', 'Endpoint')
                          : t('mcp.tooltip.command', 'Command')}
                      </dt>
                      <dd className="text-foreground truncate font-mono text-[11px]">{endpoint}</dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-2">
                    <dt className="text-muted-foreground">{t('mcp.tooltip.status', 'Status')}</dt>
                    <dd className={cn('text-foreground truncate', needsAuth && 'text-amber-700')}>
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

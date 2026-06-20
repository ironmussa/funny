import type { McpServer } from '@funny/shared';
import { Loader2, Plug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

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

/** Enabled servers the agent can actually use (matches user-facing "active" toggle). */
export function isActiveMcpServer(server: McpServer): boolean {
  if (server.disabled) return false;
  if (server.status === 'needs_auth' || server.status === 'error') return false;
  return true;
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

  const activeServers = servers.filter(isActiveMcpServer);

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
        <Loader2 className="size-3.5 animate-spin" data-testid="available-mcp-loading" />
      ) : activeServers.length === 0 ? (
        <span className="text-muted-foreground/60" data-testid="available-mcp-empty">
          {t('newThread.noMcpServers')}
        </span>
      ) : (
        activeServers.map((server) => (
          <Tooltip key={server.name}>
            <TooltipTrigger asChild>
              <Badge variant="outline" size="xs" data-testid={`available-mcp-${server.name}`}>
                {server.name}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="font-mono text-xs">{server.type}</p>
              {server.source && <p className="text-muted-foreground">{server.source}</p>}
            </TooltipContent>
          </Tooltip>
        ))
      )}
    </div>
  );
}

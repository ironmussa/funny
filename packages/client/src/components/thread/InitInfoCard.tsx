import { ChevronRight } from 'lucide-react';
import { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EFFORT_LEVELS } from '@/lib/providers';
import { resolveModelLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

type ServerGroups = Map<string, string[]>;

const CONNECTOR_BOOTSTRAP_TOOLS = new Set(['authenticate', 'complete_authentication']);

function isConnectorServer(serverName: string, toolNames: string[]): boolean {
  if (serverName.startsWith('claude_ai_')) return true;
  if (toolNames.length === 0 || toolNames.length > CONNECTOR_BOOTSTRAP_TOOLS.size) return false;
  return toolNames.every((n) => CONNECTOR_BOOTSTRAP_TOOLS.has(n));
}

/**
 * Group MCP tools by server prefix and split into buckets by origin:
 *  - plugins: server name starts with `plugin_` (Claude Code plugins)
 *  - connectors: Claude.ai integrations — either `claude_ai_*` prefix, or
 *    a server exposing only `authenticate`/`complete_authentication`
 *    (unauthenticated connectors like supabase use a bare name)
 *  - mcpServers: everything else (project `.mcp.json` + user-scoped)
 * Built-in tools (no `mcp__` prefix) go to `builtIn`.
 */
function groupTools(tools: string[]) {
  const builtIn: string[] = [];
  const byServer: ServerGroups = new Map();

  for (const tool of tools) {
    const match = tool.match(/^mcp__(.+?)__(.+)$/);
    if (!match) {
      builtIn.push(tool);
      continue;
    }
    const serverName = match[1];
    const toolName = match[2];
    if (!byServer.has(serverName)) byServer.set(serverName, []);
    byServer.get(serverName)!.push(toolName);
  }

  const plugins: ServerGroups = new Map();
  const connectors: ServerGroups = new Map();
  const mcpServers: ServerGroups = new Map();

  for (const [serverName, toolNames] of byServer) {
    const bucket = serverName.startsWith('plugin_')
      ? plugins
      : isConnectorServer(serverName, toolNames)
        ? connectors
        : mcpServers;
    bucket.set(serverName, toolNames);
  }

  return { builtIn, plugins, connectors, mcpServers };
}

function initInfoAreEqual(
  prev: { initInfo: { tools: string[]; cwd: string; model: string }; effort?: string },
  next: { initInfo: { tools: string[]; cwd: string; model: string }; effort?: string },
) {
  if (prev.effort !== next.effort) return false;
  const a = prev.initInfo;
  const b = next.initInfo;
  if (a === b) return true;
  if (a.cwd !== b.cwd || a.model !== b.model) return false;
  if (a.tools === b.tools) return true;
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.tools.length; i++) {
    if (a.tools[i] !== b.tools[i]) return false;
  }
  return true;
}

export const InitInfoCard = memo(function InitInfoCard({
  initInfo,
  effort,
}: {
  initInfo: { tools: string[]; cwd: string; model: string };
  effort?: string;
}) {
  const { t } = useTranslation();
  const { builtIn, plugins, connectors, mcpServers } = useMemo(
    () => groupTools(initInfo.tools),
    [initInfo.tools],
  );
  const hasAnyTools =
    builtIn.length > 0 || plugins.size > 0 || connectors.size > 0 || mcpServers.size > 0;
  const effortLabel = effort
    ? (EFFORT_LEVELS.find((e) => e.value === effort)?.label ?? effort)
    : null;

  return (
    <div className="border-border bg-muted/50 text-muted-foreground space-y-1 rounded-lg border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.model')}</span>
        <span className="font-mono">{resolveModelLabel(initInfo.model, t)}</span>
        {effortLabel && (
          <span className="bg-secondary rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">
            {effortLabel}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.cwd')}</span>
        <span className="truncate font-mono">{initInfo.cwd}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="shrink-0 font-medium">{t('initInfo.tools')}</span>
        <div className="flex flex-wrap items-start gap-1 font-mono">
          {!hasAnyTools && (
            <span className="text-muted-foreground/60 italic">{t('initInfo.providerManaged')}</span>
          )}
          {builtIn.map((tool) => (
            <span key={tool} className="bg-secondary rounded px-1.5 py-0.5 text-xs">
              {tool}
            </span>
          ))}
        </div>
      </div>
      <ServerRow label={t('initInfo.mcpServers')} groups={mcpServers} />
      <ServerRow label={t('initInfo.plugins')} groups={plugins} />
      <ServerRow label={t('initInfo.connectors')} groups={connectors} />
    </div>
  );
}, initInfoAreEqual);

function ServerRow({ label, groups }: { label: string; groups: ServerGroups }) {
  if (groups.size === 0) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 font-medium">{label}</span>
      <div className="flex flex-wrap items-start gap-1 font-mono">
        {Array.from(groups.entries()).map(([serverName, toolNames]) => (
          <McpToolGroup key={serverName} serverName={serverName} toolNames={toolNames} />
        ))}
      </div>
    </div>
  );
}

function mcpToolGroupAreEqual(
  prev: { serverName: string; toolNames: string[] },
  next: { serverName: string; toolNames: string[] },
) {
  if (prev.serverName !== next.serverName) return false;
  if (prev.toolNames === next.toolNames) return true;
  if (prev.toolNames.length !== next.toolNames.length) return false;
  for (let i = 0; i < prev.toolNames.length; i++) {
    if (prev.toolNames[i] !== next.toolNames[i]) return false;
  }
  return true;
}

const McpToolGroup = memo(function McpToolGroup({
  serverName,
  toolNames,
}: {
  serverName: string;
  toolNames: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="bg-primary/10 hover:bg-primary/20 inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-xs">
        <ChevronRight className={cn('icon-xs', open && 'rotate-90')} />
        {serverName} ({toolNames.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-wrap gap-1">
        {toolNames.map((name) => (
          <span key={name} className="bg-secondary rounded px-1.5 py-0.5 text-xs">
            {name}
          </span>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}, mcpToolGroupAreEqual);

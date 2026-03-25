import { ChevronRight } from 'lucide-react';
import { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { resolveModelLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

/** Group MCP tools by server prefix and show built-in tools individually */
function groupTools(tools: string[]) {
  const builtIn: string[] = [];
  const mcpGroups = new Map<string, string[]>();

  for (const tool of tools) {
    const match = tool.match(/^mcp__(.+?)__(.+)$/);
    if (match) {
      const serverName = match[1];
      if (!mcpGroups.has(serverName)) mcpGroups.set(serverName, []);
      mcpGroups.get(serverName)!.push(match[2]);
    } else {
      builtIn.push(tool);
    }
  }

  return { builtIn, mcpGroups };
}

function initInfoAreEqual(
  prev: { initInfo: { tools: string[]; cwd: string; model: string } },
  next: { initInfo: { tools: string[]; cwd: string; model: string } },
) {
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
}: {
  initInfo: { tools: string[]; cwd: string; model: string };
}) {
  const { t } = useTranslation();
  const { builtIn, mcpGroups } = useMemo(() => groupTools(initInfo.tools), [initInfo.tools]);

  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.model')}</span>
        <span className="font-mono">{resolveModelLabel(initInfo.model, t)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.cwd')}</span>
        <span className="truncate font-mono">{initInfo.cwd}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="shrink-0 font-medium">{t('initInfo.tools')}</span>
        <div className="flex flex-wrap items-start gap-1 font-mono">
          {builtIn.length === 0 && mcpGroups.size === 0 && (
            <span className="italic text-muted-foreground/60">{t('initInfo.providerManaged')}</span>
          )}
          {builtIn.map((tool) => (
            <span key={tool} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
              {tool}
            </span>
          ))}
          {Array.from(mcpGroups.entries()).map(([serverName, toolNames]) => (
            <McpToolGroup key={serverName} serverName={serverName} toolNames={toolNames} />
          ))}
        </div>
      </div>
    </div>
  );
}, initInfoAreEqual);

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
      <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs transition-colors hover:bg-primary/20">
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {serverName} ({toolNames.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-wrap gap-1">
        {toolNames.map((name) => (
          <span key={name} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            {name}
          </span>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}, mcpToolGroupAreEqual);

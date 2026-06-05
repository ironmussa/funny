import type { StartupCommand } from '@funny/shared';
import { GitBranch, Loader2, Play, Rocket, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { api } from '@/lib/api';
import { useTerminalStore } from '@/stores/terminal-store';

interface Props {
  projectId: string;
  threadId?: string;
  worktreeBranch?: string;
}

/**
 * Rocket-icon popover that lists the project's startup commands and lets the
 * user start/stop them. Owned by ProjectHeader; extracted so the parent
 * doesn't import the Popover cluster.
 */
export function StartupCommandsPopover({ projectId, threadId, worktreeBranch }: Props) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [open, setOpen] = useState(false);
  const { tooltipProps, menuProps, contentProps } = useTooltipMenu();

  const tabs = useTerminalStore((s) => s.tabs);
  const runningIds = new Set<string>();
  for (const tab of tabs) {
    if (tab.commandId && tab.alive) runningIds.add(tab.commandId);
  }

  const loadCommands = useCallback(async () => {
    const result = await api.listCommands(projectId);
    if (result.isOk()) setCommands(result.value);
  }, [projectId]);

  useEffect(() => {
    if (open) loadCommands();
  }, [open, loadCommands]);

  const handleRun = async (cmd: StartupCommand) => {
    const store = useTerminalStore.getState();
    store.addTab({
      id: crypto.randomUUID(),
      label: cmd.label,
      cwd: '',
      alive: true,
      commandId: cmd.id,
      projectId,
    });
    await api.runCommand(projectId, cmd.id, threadId);
  };

  const handleStop = async (cmd: StartupCommand) => {
    await api.stopCommand(projectId, cmd.id);
  };

  const anyRunning = commands.some((cmd) => runningIds.has(cmd.id));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        menuProps.onOpenChange(next);
      }}
    >
      <Tooltip {...tooltipProps}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              data-testid="header-startup-commands"
              variant="ghost"
              size="icon-sm"
              className={anyRunning ? 'text-status-success' : 'text-muted-foreground'}
            >
              <Rocket className="icon-base" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('startup.title', 'Startup Commands')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2" {...contentProps}>
        {threadId && (
          <div
            data-testid="startup-worktree-banner"
            className="border-border/60 bg-muted/40 text-muted-foreground mb-2 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs"
          >
            <GitBranch className="icon-xs shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t('startup.inWorktree', 'In worktree')}
              {worktreeBranch ? (
                <>
                  {': '}
                  <span className="text-foreground font-mono">{worktreeBranch}</span>
                </>
              ) : null}
            </span>
          </div>
        )}
        {commands.length === 0 ? (
          <p className="text-muted-foreground py-3 text-center text-xs">
            {t('startup.noCommands')}
          </p>
        ) : (
          <div className="space-y-1">
            {commands.map((cmd) => {
              const isRunning = runningIds.has(cmd.id);
              return (
                <div
                  key={cmd.id}
                  className="hover:bg-accent/50 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {isRunning && (
                        <Loader2 className="icon-xs text-status-success shrink-0 animate-spin" />
                      )}
                      <span className="truncate text-sm">{cmd.label}</span>
                    </div>
                    <span className="text-muted-foreground mt-0.5 block truncate font-mono text-xs">
                      {cmd.command}
                    </span>
                  </div>
                  {isRunning ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleStop(cmd)}
                      className="text-status-error hover:text-status-error/80 shrink-0"
                    >
                      <Square className="icon-xs" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRun(cmd)}
                      className="text-status-success hover:text-status-success/80 shrink-0"
                    >
                      <Play className="icon-xs" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

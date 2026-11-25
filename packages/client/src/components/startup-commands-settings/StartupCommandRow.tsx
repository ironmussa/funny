import type { StartupCommand } from '@funny/shared';
import { Play, Pencil, Trash2, Square, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CommandHighlight } from '@/components/CommandHighlight';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { sendTerminalRealtime } from '@/hooks/use-ws';
import { useTerminalStore } from '@/stores/terminal-store';

function stopStartupCommand(cmd: StartupCommand) {
  const store = useTerminalStore.getState();
  const tab = store.tabs.find((candidate) => candidate.commandId === cmd.id && candidate.alive);
  if (!tab) return;

  sendTerminalRealtime(tab.id, { case: 'close', reason: 'startup-command-stopped' });
  store.removeTab(tab.id);
}

/** One startup command: its label and command, with run / stop, edit and delete. */
export function StartupCommandRow({
  cmd,
  isRunning,
  onRun,
  onEdit,
  onDelete,
}: {
  cmd: StartupCommand;
  isRunning: boolean;
  onRun: (cmd: StartupCommand) => void;
  onEdit: (cmd: StartupCommand) => void;
  onDelete: (cmdId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-item-card group flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isRunning && <Loader2 className="icon-sm text-status-success shrink-0 animate-spin" />}
          <span className="truncate text-sm font-medium">{cmd.label}</span>
        </div>
        <CommandHighlight command={cmd.command} />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isRunning ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-error" size="icon-sm" onClick={() => stopStartupCommand(cmd)}>
                <Square className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('startup.stop')}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-success" size="icon-sm" onClick={() => onRun(cmd)}>
                <Play className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('startup.run')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="muted" size="icon-sm" onClick={() => onEdit(cmd)}>
              <Pencil className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('startup.edit')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="muted-destructive" size="icon-sm" onClick={() => onDelete(cmd.id)}>
              <Trash2 className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('startup.delete')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

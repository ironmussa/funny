import { Zap } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { sendTerminalRealtime } from '@/hooks/use-ws';

/** Tab-bar menu that sends a signal to the active PTY tab. */
export function TerminalSignalMenu({ ptyId }: { ptyId: string }) {
  const { t } = useTranslation();
  const signalMenu = useTooltipMenu();

  const sendSignal = useCallback((id: string, signal: string) => {
    sendTerminalRealtime(id, { case: 'signal', signal });
  }, []);

  return (
    <DropdownMenu {...signalMenu.menuProps}>
      <Tooltip {...signalMenu.tooltipProps}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" data-testid="terminal-signal-menu">
              <Zap className="icon-sm" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('terminal.sendSignal')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" {...signalMenu.contentProps}>
        <DropdownMenuItem
          onClick={() => sendSignal(ptyId, 'SIGINT')}
          data-testid="terminal-signal-sigint"
        >
          SIGINT (Ctrl+C)
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => sendSignal(ptyId, 'SIGTERM')}
          data-testid="terminal-signal-sigterm"
        >
          SIGTERM
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => sendSignal(ptyId, 'SIGKILL')}

          data-testid="terminal-signal-sigkill"
        >
          SIGKILL (Force)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

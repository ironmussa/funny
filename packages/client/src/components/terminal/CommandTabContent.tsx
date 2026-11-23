import { Square } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { getCssVar } from '@/components/terminal/xterm-utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminal-store';

/** Format milliseconds as human-readable uptime */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Server-managed command tab — uses a <pre> log view */
export function CommandTabContent({
  commandId,
  projectId,
  active,
  alive,
}: {
  commandId: string;
  projectId?: string;
  active: boolean;
  alive: boolean;
}) {
  const { t } = useTranslation();
  const output = useTerminalStore((s) => s.commandOutput[commandId] ?? '');
  const metrics = useTerminalStore((s) => s.commandMetrics[commandId]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ansiConverter = useMemo(
    () =>
      createAnsiConverter({
        fg: getCssVar('--foreground'),
        bg: getCssVar('--background'),
        newline: true,
      }),
    [],
  );

  const htmlOutput = useMemo(
    () => (output ? ansiConverter.toHtml(output) : 'Waiting for output...'),
    [ansiConverter, output],
  );

  useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output, active]);

  const handleStop = async () => {
    if (projectId) {
      await api.stopCommand(projectId, commandId);
    }
  };

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col bg-background',
        active ? 'z-10' : 'z-0 invisible pointer-events-none',
      )}
    >
      {alive && (
        <div className="flex shrink-0 items-center gap-3 px-2 py-0.5">
          {metrics && (
            <div
              className="text-muted-foreground text-2xs flex items-center gap-3"
              data-testid="command-metrics"
            >
              <span>
                {t('terminal.uptime')}: {formatUptime(metrics.uptime)}
              </span>
              <span>
                {t('terminal.memory')}: {(metrics.memoryUsageKB / 1024).toFixed(1)} MB
              </span>
              {metrics.restartCount > 0 && (
                <span className="text-status-warning">
                  {t('terminal.restarts')}: {metrics.restartCount}
                </span>
              )}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleStop}
                className="text-status-error hover:text-status-error/80 ml-auto"
                data-testid="command-stop"
              >
                <Square className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.stop')}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-1">
        <pre
          className="text-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: htmlOutput }}
        />
      </div>
    </div>
  );
}

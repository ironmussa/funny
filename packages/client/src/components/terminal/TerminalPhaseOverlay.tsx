import { AlertCircle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import type { TerminalRenderPhase } from '@/machines/terminal-spawn-machine';

/** Overlay for a web PTY tab's spawn phase: error, exited (restart), waiting or loading. */
export function TerminalPhaseOverlay({
  phase,
  error,
  onRestart,
}: {
  phase: TerminalRenderPhase;
  error: string | undefined;
  onRestart: () => void;
}) {
  const { t } = useTranslation();

  if (phase === 'error') {
    return (
      <div className="bg-background absolute inset-0 flex items-center justify-center">
        <div className="text-destructive flex items-center gap-2 text-xs">
          <AlertCircle className="icon-base shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (phase === 'exited') {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-2">
        <Button
          variant="outline"
          size="xs"
          onClick={onRestart}
          gap="snug"
          data-testid="terminal-restart"
        >
          <RotateCcw className="icon-xs" />
          {t('terminal.restart', 'Restart')}
        </Button>
      </div>
    );
  }

  if (phase === 'awaiting-runner') {
    return (
      <div
        className="bg-background absolute inset-0 flex items-center justify-center"
        data-testid="terminal-awaiting-runner"
      >
        <LoadingState
          fill={false}
          layout="inline"
          testId="terminal-awaiting-runner-spinner"
          label={t('terminal.awaitingRunner', 'Waiting for runner to come online…')}
        />
      </div>
    );
  }

  if (
    phase === 'initializing' ||
    phase === 'awaiting-sessions' ||
    phase === 'spawning' ||
    phase === 'restoring'
  ) {
    return (
      <div className="bg-background absolute inset-0 flex items-center justify-center">
        <LoadingState
          fill={false}
          layout="inline"
          testId="terminal-loading-spinner"
          label={t('terminal.loading')}
        />
      </div>
    );
  }

  // 'connected' — no overlay
  return null;
}

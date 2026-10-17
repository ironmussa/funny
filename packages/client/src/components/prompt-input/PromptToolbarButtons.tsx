import { ArrowUp, Inbox, Loader2, Mic, MicOff, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface BacklogToggleProps {
  sendToBacklog: boolean;
  onSendToBacklogChange?: (v: boolean) => void;
}

export function BacklogToggle({ sendToBacklog, onSendToBacklogChange }: BacklogToggleProps) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          data-testid="prompt-backlog-toggle"
          onClick={() => onSendToBacklogChange?.(!sendToBacklog)}
          tabIndex={-1}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            sendToBacklog
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
          aria-label={t('prompt.sendToBacklog')}
        >
          <Inbox className="icon-xs" />
          {t('prompt.backlog')}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t('prompt.sendToBacklog')}</TooltipContent>
    </Tooltip>
  );
}

interface DictationButtonProps {
  isRecording: boolean;
  isTranscribing: boolean;
  loading: boolean;
  onToggleRecording?: () => void;
}

function DictationIcon({ isRecording, isTranscribing }: DictationButtonProps) {
  if (isTranscribing) return <Loader2 className="icon-sm animate-spin" />;
  if (isRecording) return <MicOff className="icon-sm" />;
  return <Mic className="icon-sm" />;
}

export function DictationButton(props: DictationButtonProps) {
  const { isRecording, isTranscribing, loading, onToggleRecording } = props;
  const { t } = useTranslation();
  const stopLabel = t('prompt.stopDictation', 'Stop dictation');
  const ariaLabel = isRecording ? stopLabel : t('prompt.startDictation', 'Start dictation');
  let tooltip = t('prompt.startDictationPtt', 'Voice dictation (hold Ctrl+Alt)');
  if (isTranscribing) tooltip = t('prompt.transcribing', 'Transcribing...');
  else if (isRecording) tooltip = stopLabel;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="prompt-dictate"
          onClick={onToggleRecording}
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          aria-label={ariaLabel}
          disabled={loading || isTranscribing}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            isRecording && 'text-destructive hover:text-destructive',
          )}
        >
          <DictationIcon {...props} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface SendOrStopButtonProps {
  showStop: boolean;
  loading: boolean;
  queueLabel: boolean;
  onStop?: () => void;
  onSend: () => void;
}

export function SendOrStopButton({
  showStop,
  loading,
  queueLabel,
  onStop,
  onSend,
}: SendOrStopButtonProps) {
  const { t } = useTranslation();
  if (showStop) {
    return (
      <Button
        data-testid="prompt-stop"
        onClick={onStop}
        variant="destructive"
        size="icon-sm"
        tabIndex={-1}
        aria-label={t('prompt.stopAgent')}
      >
        <Square className="icon-sm" />
      </Button>
    );
  }
  return (
    <Button
      data-testid="prompt-send"
      onClick={onSend}
      disabled={loading}
      size="icon-sm"
      tabIndex={-1}
      aria-label={queueLabel ? t('prompt.queueMessage') : t('prompt.send', 'Send message')}
    >
      {loading ? <Loader2 className="icon-sm animate-spin" /> : <ArrowUp className="icon-sm" />}
    </Button>
  );
}

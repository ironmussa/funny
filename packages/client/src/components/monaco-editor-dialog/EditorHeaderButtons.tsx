import { Maximize2, Minimize2, Eye, EyeOff, Check, Copy, GitBranch, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Copies the whole buffer. */
export function CopyContentButton({
  content,
  copied,
  onCopy,
}: {
  content: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="icon-sm"
          onClick={onCopy}
          disabled={!content}
          className="shrink-0"
          data-testid="editor-copy-content"
          aria-label={t('editor.copy', 'Copy')}
        >
          {copied ? (
            <Check className="icon-base copy-feedback-icon text-status-success" />
          ) : (
            <Copy className="icon-base copy-feedback-icon" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('editor.copy', 'Copy')}</TooltipContent>
    </Tooltip>
  );
}

/** Shows or hides the current-line blame. */
export function BlameToggle({
  showBlame,
  onToggleBlame,
}: {
  showBlame: boolean;
  onToggleBlame: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleBlame}
          className={cn('shrink-0', showBlame ? 'text-foreground' : 'text-muted-foreground')}
          data-testid="editor-toggle-blame"
        >
          <GitBranch className="icon-base" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {showBlame ? t('editor.hideBlame', 'Hide blame') : t('editor.showBlame', 'Show blame')}
      </TooltipContent>
    </Tooltip>
  );
}

/** Shows or hides the file history sidebar. */
export function HistoryToggle({
  showHistory,
  onToggleHistory,
}: {
  showHistory: boolean;
  onToggleHistory: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleHistory}
          className={cn('shrink-0', showHistory ? 'text-foreground' : 'text-muted-foreground')}
          data-testid="editor-toggle-history"
          aria-label={t('editor.toggleHistory', 'Toggle history')}
        >
          <History className="icon-base" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {showHistory
          ? t('editor.hideHistory', 'Hide history')
          : t('editor.showHistory', 'Show history')}
      </TooltipContent>
    </Tooltip>
  );
}

/** Shows or hides the Monaco minimap. */
export function MinimapToggle({
  showMinimap,
  onToggleMinimap,
}: {
  showMinimap: boolean;
  onToggleMinimap: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="icon-sm"
          onClick={onToggleMinimap}
          className="shrink-0"
          data-testid="editor-toggle-minimap"
        >
          {showMinimap ? <EyeOff className="icon-base" /> : <Eye className="icon-base" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {showMinimap ? t('editor.hideMinimap') : t('editor.showMinimap')}
      </TooltipContent>
    </Tooltip>
  );
}

/** Toggles the dialog between windowed and fullscreen. */
export function FullscreenToggle({
  isFullscreen,
  onToggleFullscreen,
}: {
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="icon-sm"
          onClick={onToggleFullscreen}
          className="shrink-0"
          data-testid="editor-toggle-fullscreen"
        >
          {isFullscreen ? <Minimize2 className="icon-base" /> : <Maximize2 className="icon-base" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
      </TooltipContent>
    </Tooltip>
  );
}

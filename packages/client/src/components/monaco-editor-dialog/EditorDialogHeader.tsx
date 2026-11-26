import { FileCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PreviewModeToggle } from '@/components/PreviewModeToggle';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { getFileName } from './editor-language';
import {
  BlameToggle,
  CopyContentButton,
  FullscreenToggle,
  HistoryToggle,
  MinimapToggle,
} from './EditorHeaderButtons';

interface ViewTogglesProps {
  canPreview: boolean;
  lockPreview: boolean;
  showPreview: boolean;
  onTogglePreview: () => void;
  inCodeView: boolean;
  hasBlame: boolean;
  showBlame: boolean;
  onToggleBlame: () => void;
  canShowHistory: boolean;
  showHistory: boolean;
  onToggleHistory: () => void;
  showMinimap: boolean;
  onToggleMinimap: () => void;
}

interface EditorDialogHeaderProps {
  filePath: string;
  content: string;
  copied: boolean;
  onCopy: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** State and handlers of the preview / blame / history / minimap toggles. */
  toggles: ViewTogglesProps;
}

/** Preview, blame, history and minimap toggles; each shows only where it applies. */
function ViewToggles({
  canPreview,
  lockPreview,
  showPreview,
  onTogglePreview,
  inCodeView,
  hasBlame,
  showBlame,
  onToggleBlame,
  canShowHistory,
  showHistory,
  onToggleHistory,
  showMinimap,
  onToggleMinimap,
}: ViewTogglesProps) {
  return (
    <>
      {canPreview && !lockPreview && (
        <PreviewModeToggle
          previewing={showPreview}
          onToggle={onTogglePreview}
          testId="editor-toggle-preview"
        />
      )}
      {inCodeView && hasBlame && (
        <BlameToggle showBlame={showBlame} onToggleBlame={onToggleBlame} />
      )}
      {canShowHistory && (
        <HistoryToggle showHistory={showHistory} onToggleHistory={onToggleHistory} />
      )}
      {inCodeView && <MinimapToggle showMinimap={showMinimap} onToggleMinimap={onToggleMinimap} />}
    </>
  );
}

/** Title bar of the editor dialog: file path and the view toggles. */
export function EditorDialogHeader({
  filePath,
  content,
  copied,
  onCopy,
  isFullscreen,
  onToggleFullscreen,
  toggles,
}: EditorDialogHeaderProps) {
  const { t } = useTranslation();
  return (
    <DialogHeader bordered className="overflow-hidden">
      <DialogTitle size="sm" withIcon mono>
        <FileCode className="icon-base shrink-0" />
        <span className="min-w-0 overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]">
          {filePath}
        </span>
      </DialogTitle>
      <CopyContentButton content={content} copied={copied} onCopy={onCopy} />
      <ViewToggles {...toggles} />
      <FullscreenToggle isFullscreen={isFullscreen} onToggleFullscreen={onToggleFullscreen} />
      <DialogDescription className="sr-only">
        {t('editor.dialogDescription', `Editor for ${getFileName(filePath)}`)}
      </DialogDescription>
    </DialogHeader>
  );
}

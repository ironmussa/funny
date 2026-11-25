import { Check, FolderPlus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';

interface NewFolderRowProps {
  inputRef: RefObject<HTMLInputElement | null>;
  name: string;
  onNameChange: (name: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}

/** The inline row that names a new folder in the current directory. */
export function NewFolderRow({
  inputRef,
  name,
  onNameChange,
  onCreate,
  onCancel,
}: NewFolderRowProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-accent/50 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5">
      <FolderPlus className="icon-sm text-status-info shrink-0" />
      <Input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') onCreate();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={t('folderPicker.newFolderPlaceholder')}
        textSize="xs"
        mono="explorer"
        className="h-6 flex-1"
        data-testid="folder-picker-new-folder-input"
      />
      <TooltipIconButton
        size="icon"
        onClick={onCreate}
        disabled={!name.trim()}
        className="size-6 shrink-0"
        tooltip={t('folderPicker.create')}
        data-testid="folder-picker-new-folder-confirm"
      >
        <Check className="icon-xs" />
      </TooltipIconButton>
      <TooltipIconButton
        size="icon"
        onClick={onCancel}
        className="size-6 shrink-0"
        tooltip={t('folderPicker.cancel')}
        data-testid="folder-picker-new-folder-cancel"
      >
        <X className="icon-xs" />
      </TooltipIconButton>
    </div>
  );
}

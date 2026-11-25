import { SiGithub } from '@icons-pack/react-simple-icons';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type AddMode = 'local' | 'github';

interface AddModeTabsProps {
  mode: AddMode;
  hidden: boolean;
  onModeChange: (mode: AddMode) => void;
}

export function AddModeTabs({ mode, hidden, onModeChange }: AddModeTabsProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex gap-1 rounded-lg bg-muted p-1', hidden && 'hidden')}>
      <button
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          mode === 'local'
            ? 'bg-background text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid="add-project-tab-local"
        onClick={() => onModeChange('local')}
      >
        <FolderOpen className="icon-sm" />
        {t('github.localFolder')}
      </button>
      <button
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          mode === 'github'
            ? 'bg-background text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid="add-project-tab-clone"
        onClick={() => onModeChange('github')}
      >
        <SiGithub className="icon-sm" />
        {t('github.cloneFromGithub')}
      </button>
    </div>
  );
}

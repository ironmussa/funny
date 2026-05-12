import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { FolderPicker } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

interface Props {
  projectId: string;
  currentPath: string;
}

const GIT_INIT_TRIGGERS = ['Not a git repository', 'nested inside another git repository'];

export function ProjectPathSetting({ projectId, currentPath }: Props) {
  const { t } = useTranslation();
  const updateProject = useProjectStore((s) => s.updateProject);
  const [value, setValue] = useState(currentPath);
  const [lastSeenPath, setLastSeenPath] = useState(currentPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gitInitOpen, setGitInitOpen] = useState(false);

  // Reset the editor value when the parent passes a new path (e.g. after save).
  // Adjust during render instead of in an effect to avoid a stale first render.
  if (currentPath !== lastSeenPath) {
    setLastSeenPath(currentPath);
    setValue(currentPath);
  }

  const dirty = value.trim() !== currentPath && value.trim().length > 0;

  const trySave = async (path: string) => {
    const result = await updateProject(projectId, { path });
    if (result.isOk()) {
      toast.success(t('settings.projectSaved'), { id: 'project-settings-saved' });
      return { ok: true as const };
    }
    return { ok: false as const, message: result.error.message };
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await trySave(value.trim());
      if (!res.ok) {
        if (GIT_INIT_TRIGGERS.some((s) => res.message.includes(s))) {
          setGitInitOpen(true);
        } else {
          toast.error(res.message, { id: 'project-settings-saved' });
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleGitInit = async () => {
    setGitInitOpen(false);
    setSaving(true);
    try {
      const path = value.trim();
      const initResult = await api.gitInit(path);
      if (initResult.isErr()) {
        toast.error(initResult.error.message, { id: 'project-settings-saved' });
        return;
      }
      const res = await trySave(path);
      if (!res.ok) toast.error(res.message, { id: 'project-settings-saved' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border/50 px-4 py-3.5 last:border-b-0">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t('settings.projectPath', 'Project Path')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'settings.projectPathDesc',
              'Absolute path to the git repository. Existing threads keep their original worktrees; new threads will use the updated path.',
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            data-testid="settings-project-path"
            className="flex-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="/absolute/path/to/repo"
          />
          <TooltipIconButton
            data-testid="settings-project-path-browse"
            variant="outline"
            size="icon"
            onClick={() => setPickerOpen(true)}
            tooltip={t('sidebar.browseFolder', 'Browse folder')}
            aria-label={t('sidebar.browseFolder', 'Browse folder')}
          >
            <FolderOpen className="icon-base" />
          </TooltipIconButton>
          <Button
            data-testid="settings-project-path-save"
            size="sm"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? t('common.loading', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </div>
      </div>
      {pickerOpen && (
        <FolderPicker
          onSelect={(p) => {
            setValue(p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <Dialog open={gitInitOpen} onOpenChange={setGitInitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('confirm.gitInitTitle', { defaultValue: 'Initialize Git Repository' })}
            </DialogTitle>
            <DialogDescription>{t('confirm.notGitRepo', { path: value.trim() })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              data-testid="settings-git-init-cancel"
              variant="outline"
              onClick={() => setGitInitOpen(false)}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button data-testid="settings-git-init-confirm" onClick={handleGitInit}>
              {t('confirm.gitInitAction', { defaultValue: 'Initialize' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

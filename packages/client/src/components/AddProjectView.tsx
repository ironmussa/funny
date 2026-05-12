import { FolderOpen, Loader2, Plus, Github } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

import { CloneRepoView } from './CloneRepoView';
import { FolderPicker } from './FolderPicker';

type AddMode = 'local' | 'github';

export function AddProjectView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loadProjects = useAppStore((s) => s.loadProjects);
  const [mode, setMode] = useState<AddMode>('local');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [gitInitDialogOpen, setGitInitDialogOpen] = useState(false);
  const [isCloning, setIsCloning] = useState(false);

  const handleGitInit = async () => {
    setGitInitDialogOpen(false);
    setIsCreating(true);
    const initResult = await api.gitInit(newProjectPath);
    if (initResult.isErr()) {
      toastError(initResult.error, 'createProject');
      setIsCreating(false);
      return;
    }
    const retryResult = await api.createProject(newProjectName, newProjectPath);
    if (retryResult.isErr()) {
      toastError(retryResult.error, 'createProject');
      setIsCreating(false);
      return;
    }
    await loadProjects();
    toast.success(
      t('project.created', {
        name: newProjectName,
        defaultValue: `Project "${newProjectName}" created`,
      }),
    );
    navigate(buildPath(`/projects/${retryResult.value.id}`));
    setIsCreating(false);
  };

  const handleAddProject = async () => {
    if (!newProjectName || !newProjectPath || isCreating) return;
    setIsCreating(true);
    const result = await api.createProject(newProjectName, newProjectPath);
    if (result.isErr()) {
      if (
        result.error.message?.includes('Not a git repository') ||
        result.error.message?.includes('nested inside another git repository')
      ) {
        setIsCreating(false);
        setGitInitDialogOpen(true);
        return;
      }
      toastError(result.error, 'createProject');
      setIsCreating(false);
      return;
    }
    await loadProjects();
    toast.success(
      t('project.created', {
        name: newProjectName,
        defaultValue: `Project "${newProjectName}" created`,
      }),
    );
    navigate(buildPath(`/projects/${result.value.id}`));
    setIsCreating(false);
  };

  return (
    <ScrollArea className="flex flex-1 justify-center pt-[10vh]">
      <div className="mx-auto w-full max-w-md space-y-6 px-4 pb-8">
        {!isCloning && (
          <div className="space-y-2 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
              <Plus className="icon-xl text-primary" />
            </div>
            <h2 className="text-xl font-semibold">{t('sidebar.addProject')}</h2>
          </div>
        )}

        {/* Tab toggle */}
        <div className={cn('flex gap-1 rounded-lg bg-muted p-1', isCloning && 'hidden')}>
          <button
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'local'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid="add-project-tab-local"
            onClick={() => setMode('local')}
          >
            <FolderOpen className="icon-sm" />
            {t('github.localFolder')}
          </button>
          <button
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'github'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid="add-project-tab-clone"
            onClick={() => setMode('github')}
          >
            <Github className="icon-sm" />
            {t('github.cloneFromGithub')}
          </button>
        </div>

        {mode === 'local' ? (
          <div className="space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              {t('sidebar.addProjectDescription', {
                defaultValue: 'Enter the project name and select the folder path.',
              })}
            </p>
            <div>
              <label className="mb-1.5 block text-sm font-medium">{t('sidebar.projectName')}</label>
              <Input
                data-testid="add-project-name"
                placeholder={t('sidebar.projectName')}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                {t('sidebar.absolutePath')}
              </label>
              <div className="flex gap-2">
                <Input
                  data-testid="add-project-path"
                  className="flex-1"
                  placeholder={t('sidebar.absolutePath')}
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid="add-project-browse"
                      variant="outline"
                      size="sm"
                      onClick={() => setFolderPickerOpen(true)}
                      aria-label={t('sidebar.browseFolder')}
                    >
                      <FolderOpen className="icon-base" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('sidebar.browseFolder')}</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                data-testid="add-project-cancel"
                variant="outline"
                className="flex-1"
                onClick={() => navigate(buildPath('/'))}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button
                data-testid="add-project-submit"
                className="flex-1"
                onClick={handleAddProject}
                disabled={isCreating || !newProjectName || !newProjectPath}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="icon-base mr-2 animate-spin" />
                    {t('common.loading')}
                  </>
                ) : (
                  t('sidebar.add')
                )}
              </Button>
            </div>
          </div>
        ) : (
          <CloneRepoView onCloningChange={setIsCloning} />
        )}
      </div>

      {folderPickerOpen && (
        <FolderPicker
          onSelect={async (path) => {
            setNewProjectPath(path);
            setFolderPickerOpen(false);
            if (!newProjectName) {
              const result = await api.repoName(path);
              if (result.isOk() && result.value.name) {
                setNewProjectName(result.value.name);
              } else {
                const folderName = path.split(/[\\/]/).filter(Boolean).pop() || '';
                setNewProjectName(folderName);
              }
            }
          }}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}

      <Dialog open={gitInitDialogOpen} onOpenChange={setGitInitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('confirm.gitInitTitle', { defaultValue: 'Initialize Git Repository' })}
            </DialogTitle>
            <DialogDescription>
              {t('confirm.notGitRepo', { path: newProjectPath })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              data-testid="git-init-cancel"
              variant="outline"
              onClick={() => setGitInitDialogOpen(false)}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button data-testid="git-init-confirm" onClick={handleGitInit}>
              {t('confirm.gitInitAction', { defaultValue: 'Initialize' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}

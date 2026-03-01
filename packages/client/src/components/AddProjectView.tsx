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
import { api } from '@/lib/api';
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

  const handleGitInit = async () => {
    setGitInitDialogOpen(false);
    setIsCreating(true);
    const initResult = await api.gitInit(newProjectPath);
    if (initResult.isErr()) {
      toast.error(initResult.error.message);
      setIsCreating(false);
      return;
    }
    const retryResult = await api.createProject(newProjectName, newProjectPath);
    if (retryResult.isErr()) {
      toast.error(retryResult.error.message);
      setIsCreating(false);
      return;
    }
    await loadProjects();
    navigate('/');
    navigate(`/projects/${retryResult.value.id}`);
    setIsCreating(false);
  };

  const handleAddProject = async () => {
    if (!newProjectName || !newProjectPath || isCreating) return;
    setIsCreating(true);
    const result = await api.createProject(newProjectName, newProjectPath);
    if (result.isErr()) {
      if (result.error.message?.includes('Not a git repository')) {
        setIsCreating(false);
        setGitInitDialogOpen(true);
        return;
      }
      toast.error(result.error.message);
      setIsCreating(false);
      return;
    }
    await loadProjects();
    navigate('/');
    navigate(`/projects/${result.value.id}`);
    setIsCreating(false);
  };

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md space-y-6 px-4">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Plus className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-xl font-semibold">{t('sidebar.addProject')}</h2>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'local'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid="add-project-tab-local"
            onClick={() => setMode('local')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
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
            <Github className="h-3.5 w-3.5" />
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
                <Button
                  data-testid="add-project-browse"
                  variant="outline"
                  size="sm"
                  onClick={() => setFolderPickerOpen(true)}
                  title={t('sidebar.browseFolder')}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                data-testid="add-project-cancel"
                variant="outline"
                className="flex-1"
                onClick={() => navigate('/')}
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('common.loading')}
                  </>
                ) : (
                  t('sidebar.add')
                )}
              </Button>
            </div>
          </div>
        ) : (
          <CloneRepoView />
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
    </div>
  );
}

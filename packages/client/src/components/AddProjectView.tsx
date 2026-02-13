import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FolderOpen, Loader2, Plus, Github } from 'lucide-react';
import { FolderPicker } from './FolderPicker';
import { CloneRepoView } from './CloneRepoView';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/app-store';

type AddMode = 'local' | 'github';

export function AddProjectView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loadProjects = useAppStore(s => s.loadProjects);
  const setAddProjectOpen = useAppStore(s => s.setAddProjectOpen);
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
    setAddProjectOpen(false);
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
    setAddProjectOpen(false);
    navigate(`/projects/${result.value.id}`);
    setIsCreating(false);
  };

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md space-y-6 px-4">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Plus className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-xl font-semibold">{t('sidebar.addProject')}</h2>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'local'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('local')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('github.localFolder')}
          </button>
          <button
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'github'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('github')}
          >
            <Github className="h-3.5 w-3.5" />
            {t('github.cloneFromGithub')}
          </button>
        </div>

        {mode === 'local' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              {t('sidebar.addProjectDescription', { defaultValue: 'Enter the project name and select the folder path.' })}
            </p>
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                {t('sidebar.projectName')}
              </label>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={t('sidebar.projectName')}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                {t('sidebar.absolutePath')}
              </label>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder={t('sidebar.absolutePath')}
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                />
                <Button
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
                variant="outline"
                className="flex-1"
                onClick={() => setAddProjectOpen(false)}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button
                className="flex-1"
                onClick={handleAddProject}
                disabled={isCreating || !newProjectName || !newProjectPath}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
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
            <DialogTitle>{t('confirm.gitInitTitle', { defaultValue: 'Initialize Git Repository' })}</DialogTitle>
            <DialogDescription>
              {t('confirm.notGitRepo', { path: newProjectPath })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGitInitDialogOpen(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={handleGitInit}>
              {t('confirm.gitInitAction', { defaultValue: 'Initialize' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

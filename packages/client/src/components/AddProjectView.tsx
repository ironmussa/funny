import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FolderOpen, Loader2, Plus } from 'lucide-react';
import { FolderPicker } from './FolderPicker';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/app-store';

export function AddProjectView() {
  const { t } = useTranslation();
  const loadProjects = useAppStore(s => s.loadProjects);
  const setAddProjectOpen = useAppStore(s => s.setAddProjectOpen);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleAddProject = async () => {
    if (!newProjectName || !newProjectPath || isCreating) return;
    setIsCreating(true);
    try {
      await api.createProject(newProjectName, newProjectPath);
      await loadProjects();
      setAddProjectOpen(false);
    } catch (e: any) {
      if (e.message?.includes('Not a git repository')) {
        const init = confirm(
          t('confirm.notGitRepo', { path: newProjectPath })
        );
        if (init) {
          try {
            await fetch('/api/browse/git-init', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: newProjectPath }),
            });
            await api.createProject(newProjectName, newProjectPath);
            await loadProjects();
            setAddProjectOpen(false);
          } catch (initErr: any) {
            toast.error(initErr.message);
          }
        }
      } else {
        toast.error(e.message);
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md space-y-6 px-4">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Plus className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-xl font-semibold">{t('sidebar.addProject')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('sidebar.addProjectDescription', { defaultValue: 'Enter the project name and select the folder path.' })}
          </p>
        </div>

        <div className="space-y-4">
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
      </div>

      {folderPickerOpen && (
        <FolderPicker
          onSelect={async (path) => {
            setNewProjectPath(path);
            setFolderPickerOpen(false);
            if (!newProjectName) {
              try {
                const res = await fetch(`/api/browse/repo-name?path=${encodeURIComponent(path)}`);
                const data = await res.json();
                if (data.name) setNewProjectName(data.name);
              } catch {
                const folderName = path.split(/[\\/]/).filter(Boolean).pop() || '';
                setNewProjectName(folderName);
              }
            }
          }}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}
    </div>
  );
}

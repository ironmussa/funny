import { AlertTriangle, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useProjectStore } from '@/stores/project-store';

import { FolderPicker } from './FolderPicker';

interface SetupProjectDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetupProjectDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: SetupProjectDialogProps) {
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const setProjectLocalPath = useProjectStore((s) => s.setProjectLocalPath);

  const handleSelect = async (path: string) => {
    setFolderPickerOpen(false);
    setSaving(true);
    setError('');
    const success = await setProjectLocalPath(projectId, path);
    setSaving(false);
    if (success) {
      onOpenChange(false);
    } else {
      setError('Failed to set directory. Make sure the path is a valid git repository.');
    }
  };

  return (
    <>
      <Dialog open={open && !folderPickerOpen} onOpenChange={onOpenChange}>
        <DialogContent data-testid="setup-project-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-status-warning" />
              Set up local directory
            </DialogTitle>
            <DialogDescription>
              <strong>{projectName}</strong> is a shared team project. To create threads, you need
              to select your local clone of this repository.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p className="text-sm text-status-error" data-testid="setup-project-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="setup-project-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => setFolderPickerOpen(true)}
              disabled={saving}
              data-testid="setup-project-browse"
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {saving ? 'Saving...' : 'Browse...'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {folderPickerOpen && (
        <FolderPicker onSelect={handleSelect} onClose={() => setFolderPickerOpen(false)} />
      )}
    </>
  );
}

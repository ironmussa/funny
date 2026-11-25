import type { GitHubRepo } from '@funny/shared';
import { ArrowLeft, FolderOpen, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { FolderPicker } from '../FolderPicker';

interface CloneConfigFormProps {
  selectedRepo: GitHubRepo;
  projectName: string;
  onProjectNameChange: (name: string) => void;
  destinationPath: string;
  onDestinationPathChange: (path: string) => void;
  folderPickerOpen: boolean;
  onFolderPickerOpenChange: (open: boolean) => void;
  onBack: () => void;
  onClone: () => void;
}

/** The form that names the project and picks where the selected repository is cloned. */
export function CloneConfigForm({
  selectedRepo,
  projectName,
  onProjectNameChange,
  destinationPath,
  onDestinationPathChange,
  folderPickerOpen,
  onFolderPickerOpenChange,
  onBack,
  onClone,
}: CloneConfigFormProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Button variant="muted" size="sm" className="-ml-2" onClick={onBack}>
        <ArrowLeft className="icon-sm mr-1" />
        {t('github.repos.title')}
      </Button>

      {/* Selected repo */}
      <div className="border-border space-y-1 rounded-md border p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{selectedRepo.full_name}</span>
          {selectedRepo.private && <Lock className="icon-xs text-status-pending" />}
        </div>
        {selectedRepo.description && (
          <p className="text-muted-foreground text-xs">{selectedRepo.description}</p>
        )}
      </div>

      {/* Project name */}
      <div>
        <label htmlFor="clone-project-name" className="mb-1.5 block text-sm font-medium">
          {t('github.clone.projectName')}
        </label>
        <Input
          id="clone-project-name"
          data-testid="clone-config-project-name"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
        />
      </div>

      {/* Destination path */}
      <div>
        <label htmlFor="clone-destination-path" className="mb-1.5 block text-sm font-medium">
          {t('github.clone.destination')}
        </label>
        <div className="flex gap-2">
          <Input
            id="clone-destination-path"
            data-testid="clone-config-destination"
            className="flex-1"
            placeholder={t('github.clone.destinationDesc')}
            value={destinationPath}
            onChange={(e) => onDestinationPathChange(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="clone-config-browse"
            onClick={() => onFolderPickerOpenChange(true)}
          >
            <FolderOpen className="icon-base" />
          </Button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <Button
          variant="outline"
          className="flex-1"
          data-testid="clone-config-cancel"
          onClick={onBack}
        >
          {t('common.cancel')}
        </Button>
        <Button
          className="flex-1"
          data-testid="clone-config-submit"
          onClick={onClone}
          disabled={!destinationPath || !projectName}
        >
          {t('github.clone.cloneAndCreate')}
        </Button>
      </div>

      {folderPickerOpen && (
        <FolderPicker
          onSelect={(path) => {
            onDestinationPathChange(path);
            onFolderPickerOpenChange(false);
          }}
          onClose={() => onFolderPickerOpenChange(false)}
        />
      )}
    </div>
  );
}

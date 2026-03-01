import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { settingsItems, settingsLabelKeys } from '@/components/SettingsPanel';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
} from '@/components/ui/command';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useProjectStore((s) => s.projects);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const handleProjectSelect = (projectId: string) => {
    onOpenChange(false);
    startNewThread(projectId);
    useGitStatusStore.getState().fetchForProject(projectId);
    navigate(`/projects/${projectId}`);
  };

  const handleSettingsSelect = (itemId: string) => {
    onOpenChange(false);
    setSettingsOpen(true);
    navigate(`/settings/${itemId}`);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="command-palette-search"
        placeholder={t('commandPalette.searchPlaceholder')}
      />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>
        <CommandGroup heading={t('commandPalette.projects')}>
          {projects.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t('commandPalette.noProjects')}
            </div>
          ) : (
            projects.map((project) => (
              <CommandItem
                key={project.id}
                data-testid={`command-palette-project-${project.id}`}
                value={`${project.name} ${project.path}`}
                onSelect={() => handleProjectSelect(project.id)}
              >
                <FolderOpen className="h-4 w-4 flex-shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{project.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{project.path}</span>
                </div>
              </CommandItem>
            ))
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPalette.settings')}>
          {settingsItems.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.id}
                data-testid={`command-palette-settings-${item.id}`}
                value={item.label}
                onSelect={() => handleSettingsSelect(item.id)}
              >
                <Icon className="h-4 w-4" />
                <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

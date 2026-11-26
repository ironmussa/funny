import type { StartupCommand } from '@funny/shared';
import { Plus, X, Check } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { StartupCommandEditForm } from '@/components/startup-commands-settings/StartupCommandEditForm';
import { StartupCommandRow } from '@/components/startup-commands-settings/StartupCommandRow';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useProjects } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';

export function StartupCommandsSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  const loadCommands = useCallback(async () => {
    if (!selectedProjectId) return;
    const result = await api.listCommands(selectedProjectId);
    if (result.isOk()) {
      setCommands(result.value);
    }
    // ignore errors
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    void api.listCommands(selectedProjectId).then((result) => {
      if (result.isOk()) setCommands(result.value);
      // ignore errors
    });
  }, [selectedProjectId]);

  // Sync running state from terminal store
  const tabs = useTerminalStore((s) => s.tabs);
  const runningIds = new Set<string>();
  for (const tab of tabs) {
    if (tab.commandId && tab.alive) runningIds.add(tab.commandId);
  }

  const handleAdd = async () => {
    if (!selectedProjectId) return;
    if (!label.trim()) {
      toast.error(t('startup.labelRequired'));
      return;
    }
    if (!command.trim()) {
      toast.error(t('startup.commandRequired'));
      return;
    }
    const result = await api.addCommand(selectedProjectId, label.trim(), command.trim());
    if (result.isOk()) {
      resetForm();
      setAdding(false);
      loadCommands();
      toast.success(t('startup.commandAdded'));
    } else {
      toast.error(t('startup.commandAddError'));
    }
  };

  const handleUpdate = async (cmdId: string) => {
    if (!selectedProjectId) return;
    if (!label.trim()) {
      toast.error(t('startup.labelRequired'));
      return;
    }
    if (!command.trim()) {
      toast.error(t('startup.commandRequired'));
      return;
    }
    const result = await api.updateCommand(selectedProjectId, cmdId, label.trim(), command.trim());
    if (result.isOk()) {
      setEditingId(null);
      resetForm();
      loadCommands();
      toast.success(t('startup.commandUpdated'));
    } else {
      toast.error(t('startup.commandUpdateError'));
    }
  };

  const handleDelete = async (cmdId: string) => {
    if (!selectedProjectId) return;
    const result = await api.deleteCommand(selectedProjectId, cmdId);
    if (result.isOk()) {
      loadCommands();
      toast.success(t('startup.commandDeleted'));
    } else {
      toast.error(t('startup.commandDeleteError'));
    }
  };

  const handleRun = (cmd: StartupCommand) => {
    if (!selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    if (!project) return;
    const store = useTerminalStore.getState();
    store.addTab({
      id: crypto.randomUUID(),
      label: cmd.label,
      cwd: project.path,
      alive: true,
      commandId: cmd.id,
      projectId: selectedProjectId,
      type: 'pty',
      initialCommand: cmd.command,
    });
  };

  const startEditing = (cmd: StartupCommand) => {
    setEditingId(cmd.id);
    setLabel(cmd.label);
    setCommand(cmd.command);
    setAdding(false);
  };

  const resetForm = () => {
    setLabel('');
    setCommand('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAdding(false);
    resetForm();
  };

  if (!selectedProjectId) {
    return <EmptyState padding="md" fill={false} title={t('startup.noCommands')} />;
  }

  return (
    <div className="space-y-4">
      {/* Add button — hidden when empty state is shown */}
      {(commands.length > 0 || adding) && (
        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            gap="snug"
            onClick={() => {
              cancelEdit();
              setAdding(true);
            }}
          >
            <Plus className="icon-sm" />
            {t('startup.addCommand')}
          </Button>
        </div>
      )}

      {/* Command list */}
      {commands.length === 0 && !adding && (
        <EmptyState
          padding="md"
          fill={false}
          title={t('startup.noCommands')}
          action={
            <Button variant="outline" size="sm" gap="snug" onClick={() => setAdding(true)}>
              <Plus className="icon-sm" />
              {t('startup.addFirst')}
            </Button>
          }
        />
      )}

      {commands.map((cmd) => {
        const isRunning = runningIds.has(cmd.id);

        if (editingId === cmd.id) {
          return (
            <StartupCommandEditForm
              key={cmd.id}
              cmdId={cmd.id}
              label={label}
              setLabel={setLabel}
              command={command}
              setCommand={setCommand}
              onSave={handleUpdate}
              onCancel={cancelEdit}
            />
          );
        }

        return (
          <StartupCommandRow
            key={cmd.id}
            cmd={cmd}
            isRunning={isRunning}
            onRun={handleRun}
            onEdit={startEditing}
            onDelete={handleDelete}
          />
        );
      })}

      {/* Add form */}
      {adding && (
        <div className="settings-form-panel">
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label htmlFor="startup-new-label" className="settings-label">
                {t('startup.label')}
              </label>
              <Input
                id="startup-new-label"
                size="form"
                placeholder={t('startup.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoFocus
              />
            </div>
            <div className="col-span-3">
              <label htmlFor="startup-new-command" className="settings-label">
                {t('startup.command')}
              </label>
              <Input
                mono
                id="startup-new-command"
                size="form"
                placeholder={t('startup.commandPlaceholder')}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              <X className="icon-sm mr-1" />
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleAdd}>
              <Check className="icon-sm mr-1" />
              {t('startup.addCommand')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

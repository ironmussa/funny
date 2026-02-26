import type { StartupCommand } from '@funny/shared';
import { Play, Plus, Pencil, Trash2, X, Check, Square, Loader2, Terminal } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';

export function StartupCommandsSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const projects = useAppStore((s) => s.projects);
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  const project = projects.find((p) => p.id === selectedProjectId);

  const loadCommands = useCallback(async () => {
    if (!selectedProjectId) return;
    const result = await api.listCommands(selectedProjectId);
    if (result.isOk()) {
      setCommands(result.value);
    }
    // ignore errors
  }, [selectedProjectId]);

  useEffect(() => {
    loadCommands();
  }, [loadCommands]);

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

  const handleRun = async (cmd: StartupCommand) => {
    if (!selectedProjectId) return;
    const store = useTerminalStore.getState();
    store.addTab({
      id: crypto.randomUUID(),
      label: cmd.label,
      cwd: '',
      alive: true,
      commandId: cmd.id,
      projectId: selectedProjectId,
    });
    await api.runCommand(selectedProjectId, cmd.id);
    // ignore errors
  };

  const handleStop = async (cmd: StartupCommand) => {
    if (!selectedProjectId) return;
    await api.stopCommand(selectedProjectId, cmd.id);
    // ignore errors
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
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t('startup.noCommands')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Project indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          <span>
            {t('startup.title')}{' '}
            {project && <span className="font-medium text-foreground">{project.name}</span>}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => {
            cancelEdit();
            setAdding(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('startup.addCommand')}
        </Button>
      </div>

      {/* Command list */}
      {commands.length === 0 && !adding && (
        <div className="py-8 text-center">
          <p className="mb-3 text-sm text-muted-foreground">{t('startup.noCommands')}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('startup.addFirst')}
          </Button>
        </div>
      )}

      {commands.map((cmd) => {
        const isRunning = runningIds.has(cmd.id);

        if (editingId === cmd.id) {
          return (
            <div key={cmd.id} className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {t('startup.label')}
                  </label>
                  <Input
                    className="h-auto py-1.5"
                    placeholder={t('startup.label')}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="col-span-3">
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {t('startup.command')}
                  </label>
                  <Input
                    className="h-auto py-1.5 font-mono"
                    placeholder={t('startup.command')}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdate(cmd.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  {t('common.cancel')}
                </Button>
                <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdate(cmd.id)}>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {t('common.save')}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div
            key={cmd.id}
            className="group flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5 transition-colors hover:bg-accent/30"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isRunning && (
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-status-success" />
                )}
                <span className="truncate text-sm font-medium">{cmd.label}</span>
              </div>
              <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                {cmd.command}
              </span>
            </div>

            {/* Actions */}
            <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {isRunning ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleStop(cmd)}
                      className="text-status-error hover:text-status-error/80"
                    >
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('startup.stop')}</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRun(cmd)}
                      className="text-status-success hover:text-status-success/80"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('startup.run')}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => startEditing(cmd)}
                    className="text-muted-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('startup.edit')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleDelete(cmd.id)}
                    className="text-muted-foreground hover:text-status-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('startup.delete')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        );
      })}

      {/* Add form */}
      {adding && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('startup.label')}
              </label>
              <Input
                className="h-auto py-1.5"
                placeholder={t('startup.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoFocus
              />
            </div>
            <div className="col-span-3">
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('startup.command')}
              </label>
              <Input
                className="h-auto py-1.5 font-mono"
                placeholder={t('startup.commandPlaceholder')}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleAdd}>
              <Check className="mr-1 h-3.5 w-3.5" />
              {t('startup.addCommand')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Play, Plus, Pencil, Trash2, X, Check, Square, Loader2, Globe, RefreshCw, XCircle, Terminal } from 'lucide-react';
import { usePreviewStore } from '@/stores/preview-store';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import type { StartupCommand } from '@a-parallel/shared';

const inputClass =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

export function StartupCommandsSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [port, setPort] = useState('');
  const [portEnvVar, setPortEnvVar] = useState('');

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

  const { openPreview, closePreview, refreshPreview, isTauri } = usePreviewWindow();
  const previewTabs = usePreviewStore((s) => s.tabs);

  const handleAdd = async () => {
    if (!selectedProjectId || !label.trim() || !command.trim()) return;
    const portNum = port ? parseInt(port, 10) : null;
    const result = await api.addCommand(selectedProjectId, label.trim(), command.trim(), portNum, portEnvVar.trim() || null);
    if (result.isOk()) {
      resetForm();
      setAdding(false);
      loadCommands();
    }
  };

  const handleUpdate = async (cmdId: string) => {
    if (!selectedProjectId || !label.trim() || !command.trim()) return;
    const portNum = port ? parseInt(port, 10) : null;
    const result = await api.updateCommand(selectedProjectId, cmdId, label.trim(), command.trim(), portNum, portEnvVar.trim() || null);
    if (result.isOk()) {
      setEditingId(null);
      resetForm();
      loadCommands();
    }
  };

  const handleDelete = async (cmdId: string) => {
    if (!selectedProjectId) return;
    const result = await api.deleteCommand(selectedProjectId, cmdId);
    if (result.isOk()) {
      loadCommands();
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
      port: cmd.port ?? undefined,
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
    setPort(cmd.port ? String(cmd.port) : '');
    setPortEnvVar(cmd.portEnvVar || '');
    setAdding(false);
  };

  const resetForm = () => {
    setLabel('');
    setCommand('');
    setPort('');
    setPortEnvVar('');
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
          className="h-7 text-xs gap-1.5"
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
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground mb-3">{t('startup.noCommands')}</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('startup.addFirst')}
          </Button>
        </div>
      )}

      {commands.map((cmd) => {
        const isRunning = runningIds.has(cmd.id);

        if (editingId === cmd.id) {
          return (
            <div key={cmd.id} className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">{t('startup.label')}</label>
                  <input
                    className={inputClass}
                    placeholder={t('startup.label')}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">{t('startup.command')}</label>
                  <input
                    className={`${inputClass} font-mono`}
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
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">{t('startup.envVar')}</label>
                  <input
                    className={`${inputClass} font-mono`}
                    placeholder={t('startup.envVar')}
                    value={portEnvVar}
                    onChange={(e) => setPortEnvVar(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdate(cmd.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">{t('startup.port')}</label>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className={`${inputClass} font-mono`}
                    placeholder={t('startup.port')}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdate(cmd.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end pt-1">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t('common.cancel')}
                </Button>
                <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdate(cmd.id)}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  {t('common.save')}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div
            key={cmd.id}
            className="group flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/50 bg-card hover:bg-accent/30 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isRunning && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-green-400 flex-shrink-0" />
                )}
                <span className="text-sm font-medium truncate">{cmd.label}</span>
              </div>
              <span className="text-xs text-muted-foreground font-mono truncate block mt-0.5">{cmd.command}</span>
              <div className="flex items-center gap-3 mt-1">
                {cmd.portEnvVar && (
                  <span className="text-[10px] font-mono text-purple-400">{cmd.portEnvVar}</span>
                )}
                {cmd.port && (
                  <span className="text-[10px] font-mono text-blue-400">:{cmd.port}</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              {isRunning ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleStop(cmd)}
                      className="text-red-400 hover:text-red-300"
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
                      className="text-green-400 hover:text-green-300"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('startup.run')}</TooltipContent>
                </Tooltip>
              )}
              {isTauri && isRunning && cmd.port && (
                <>
                  {previewTabs.some((t) => t.commandId === cmd.id) ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => refreshPreview(cmd.id)}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('preview.refresh')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => closePreview(cmd.id)}
                            className="text-muted-foreground hover:text-red-400"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('preview.close')}</TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openPreview({
                            commandId: cmd.id,
                            projectId: selectedProjectId!,
                            port: cmd.port!,
                            commandLabel: cmd.label,
                          })}
                          className="text-blue-400 hover:text-blue-300"
                        >
                          <Globe className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('preview.open')}</TooltipContent>
                    </Tooltip>
                  )}
                </>
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
                    className="text-muted-foreground hover:text-red-400"
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
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('startup.label')}</label>
              <input
                className={inputClass}
                placeholder={t('startup.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('startup.command')}</label>
              <input
                className={`${inputClass} font-mono`}
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('startup.envVar')}</label>
              <input
                className={`${inputClass} font-mono`}
                placeholder={t('startup.envVar')}
                value={portEnvVar}
                onChange={(e) => setPortEnvVar(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('startup.port')}</label>
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                className={`${inputClass} font-mono`}
                placeholder={t('startup.port')}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-2 justify-end pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
              <X className="h-3.5 w-3.5 mr-1" />
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleAdd}>
              <Check className="h-3.5 w-3.5 mr-1" />
              {t('startup.addCommand')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

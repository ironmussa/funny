import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ProjectHook } from '@funny/shared';
import { Plus, Pencil, Trash2, X, Check, GripVertical } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CommandHighlight } from '@/components/CommandHighlight';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

const HOOK_TYPES = ['postCommit', 'postPush', 'preMerge'] as const;

/* ── Draggable hook row ── */
function HookItem({
  hook,
  hookTypeLabel,
  onEdit,
  onDelete,
  onToggleEnabled,
  t,
}: {
  hook: ProjectHook;
  hookTypeLabel: (type: string) => string;
  onEdit: (hook: ProjectHook) => void;
  onDelete: (hookId: string) => void;
  onToggleEnabled: (hook: ProjectHook) => void;
  t: (key: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const handle = handleRef.current;
    if (!el || !handle) return;

    const cleanupDrag = draggable({
      element: el,
      dragHandle: handle,
      getInitialData: () => ({ type: 'hook-item', hookId: hook.id }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    const cleanupDrop = dropTargetForElements({
      element: el,
      getData: () => ({ type: 'hook-item', hookId: hook.id }),
      canDrop: ({ source }) => source.data.type === 'hook-item' && source.data.hookId !== hook.id,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: () => setIsDropTarget(false),
    });

    return () => {
      cleanupDrag();
      cleanupDrop();
    };
  }, [hook.id]);

  return (
    <div
      ref={ref}
      data-testid={`hook-item-${hook.id}`}
      className={cn(
        'group flex items-center gap-1.5 rounded-md border border-border/50 bg-card px-1.5 py-1.5 transition-all hover:bg-accent/30',
        isDragging && 'opacity-40',
        isDropTarget && 'ring-2 ring-ring',
      )}
    >
      {/* Drag handle */}
      <div
        ref={handleRef}
        className="flex-shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
        data-testid={`hook-drag-${hook.id}`}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{hook.label}</span>
        <CommandHighlight command={hook.command} />
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Switch
                checked={hook.enabled}
                onCheckedChange={() => onToggleEnabled(hook)}
                data-testid={`hook-toggle-${hook.id}`}
                className="h-4 w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>{hook.enabled ? t('hooks.enabled') : t('hooks.disabled')}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onEdit(hook)}
                className="text-muted-foreground"
                data-testid={`hook-edit-${hook.id}`}
              >
                <Pencil className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('hooks.edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onDelete(hook.id)}
                className="text-muted-foreground hover:text-status-error"
                data-testid={`hook-delete-${hook.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('hooks.delete')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export function ProjectHooksSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [hooks, setHooks] = useState<ProjectHook[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hookType, setHookType] = useState<string>('postCommit');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  const loadHooks = useCallback(async () => {
    if (!selectedProjectId) return;
    const result = await api.listHooks(selectedProjectId);
    if (result.isOk()) {
      setHooks(result.value);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadHooks();
  }, [loadHooks]);

  // Drag-and-drop reorder monitor
  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const targets = location.current.dropTargets;
        if (!targets.length) return;
        if (source.data.type !== 'hook-item') return;

        const sourceId = source.data.hookId as string;
        const targetId = targets[0].data.hookId as string;
        if (sourceId === targetId) return;

        setHooks((prev) => {
          const oldIndex = prev.findIndex((h) => h.id === sourceId);
          const newIndex = prev.findIndex((h) => h.id === targetId);
          if (oldIndex === -1 || newIndex === -1) return prev;

          const reordered = [...prev];
          const [moved] = reordered.splice(oldIndex, 1);
          reordered.splice(newIndex, 0, moved);

          // Persist sortOrder for hooks that changed position
          if (selectedProjectId) {
            reordered.forEach((hook, index) => {
              if (hook.sortOrder !== index) {
                api.updateHook(selectedProjectId, hook.id, { sortOrder: index });
              }
            });
          }

          return reordered.map((h, i) => ({ ...h, sortOrder: i }));
        });
      },
    });
  }, [selectedProjectId]);

  const handleAdd = async () => {
    if (!selectedProjectId) return;
    if (!label.trim()) {
      toast.error(t('hooks.labelRequired'));
      return;
    }
    if (!command.trim()) {
      toast.error(t('hooks.commandRequired'));
      return;
    }
    const result = await api.addHook(selectedProjectId, {
      hookType,
      label: label.trim(),
      command: command.trim(),
    });
    if (result.isOk()) {
      resetForm();
      setAdding(false);
      loadHooks();
      toast.success(t('hooks.hookAdded'));
    } else {
      toast.error(t('hooks.hookAddError'));
    }
  };

  const handleUpdate = async (hookId: string) => {
    if (!selectedProjectId) return;
    if (!label.trim()) {
      toast.error(t('hooks.labelRequired'));
      return;
    }
    if (!command.trim()) {
      toast.error(t('hooks.commandRequired'));
      return;
    }
    const result = await api.updateHook(selectedProjectId, hookId, {
      hookType,
      label: label.trim(),
      command: command.trim(),
    });
    if (result.isOk()) {
      setEditingId(null);
      resetForm();
      loadHooks();
      toast.success(t('hooks.hookUpdated'));
    } else {
      toast.error(t('hooks.hookUpdateError'));
    }
  };

  const handleDelete = async (hookId: string) => {
    if (!selectedProjectId) return;
    const result = await api.deleteHook(selectedProjectId, hookId);
    if (result.isOk()) {
      loadHooks();
      toast.success(t('hooks.hookDeleted'));
    } else {
      toast.error(t('hooks.hookDeleteError'));
    }
  };

  const handleToggleEnabled = async (hook: ProjectHook) => {
    if (!selectedProjectId) return;
    const result = await api.updateHook(selectedProjectId, hook.id, {
      enabled: !hook.enabled,
    });
    if (result.isOk()) {
      loadHooks();
    }
  };

  const startEditing = (hook: ProjectHook) => {
    setEditingId(hook.id);
    setHookType(hook.hookType);
    setLabel(hook.label);
    setCommand(hook.command);
    setAdding(false);
  };

  const resetForm = () => {
    setHookType('postCommit');
    setLabel('');
    setCommand('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAdding(false);
    resetForm();
  };

  const hookTypeLabelFn = (type: string) => {
    const key = `hooks.${type}` as const;
    return t(key);
  };

  // Group hooks by type, preserving sortOrder within each group
  const hookGroups = useMemo(() => {
    const grouped = new Map<string, ProjectHook[]>();
    for (const type of HOOK_TYPES) {
      const items = hooks.filter((h) => h.hookType === type);
      if (items.length > 0) grouped.set(type, items);
    }
    return [...grouped.entries()];
  }, [hooks]);

  if (!selectedProjectId) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">{t('hooks.noHooks')}</div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          data-testid="hooks-add"
          onClick={() => {
            cancelEdit();
            setAdding(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('hooks.addHook')}
        </Button>
      </div>

      {/* Empty state */}
      {hooks.length === 0 && !adding && (
        <div className="py-8 text-center">
          <p className="mb-3 text-sm text-muted-foreground">{t('hooks.noHooks')}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('hooks.addFirst')}
          </Button>
        </div>
      )}

      {/* Hook list grouped by type */}
      {hookGroups.map(([type, groupHooks]) => (
        <div key={type} className="space-y-2">
          <h3 className="px-1 text-sm font-semibold text-muted-foreground">
            {hookTypeLabelFn(type)}
          </h3>
          {groupHooks.map((hook) => {
            if (editingId === hook.id) {
              return (
                <div
                  key={hook.id}
                  data-testid={`hook-item-${hook.id}`}
                  className="space-y-2 rounded-lg border border-border bg-muted/30 p-3"
                >
                  <div className="grid grid-cols-6 gap-2">
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        {t('hooks.hookType')}
                      </label>
                      <Select value={hookType} onValueChange={setHookType}>
                        <SelectTrigger className="text-sm" data-testid="hooks-type-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HOOK_TYPES.map((ht) => (
                            <SelectItem key={ht} value={ht} className="text-sm">
                              {hookTypeLabelFn(ht)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs text-muted-foreground">
                        {t('hooks.label')}
                      </label>
                      <Input
                        className="h-auto py-1.5"
                        placeholder={t('hooks.label')}
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        data-testid="hooks-label-input"
                        autoFocus
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="mb-1 block text-xs text-muted-foreground">
                        {t('hooks.command')}
                      </label>
                      <Input
                        className="h-auto py-1.5 font-mono"
                        placeholder={t('hooks.commandPlaceholder')}
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        data-testid="hooks-command-input"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleUpdate(hook.id);
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
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdate(hook.id)}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              );
            }

            return (
              <HookItem
                key={hook.id}
                hook={hook}
                hookTypeLabel={hookTypeLabelFn}
                onEdit={startEditing}
                onDelete={handleDelete}
                onToggleEnabled={handleToggleEnabled}
                t={t}
              />
            );
          })}
        </div>
      ))}

      {/* Add form */}
      {adding && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="grid grid-cols-6 gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('hooks.hookType')}
              </label>
              <Select value={hookType} onValueChange={setHookType}>
                <SelectTrigger className="text-sm" data-testid="hooks-type-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_TYPES.map((ht) => (
                    <SelectItem key={ht} value={ht} className="text-sm">
                      {hookTypeLabelFn(ht)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-muted-foreground">{t('hooks.label')}</label>
              <Input
                className="h-auto py-1.5"
                placeholder={t('hooks.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                data-testid="hooks-label-input"
                autoFocus
              />
            </div>
            <div className="col-span-3">
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('hooks.command')}
              </label>
              <Input
                className="h-auto py-1.5 font-mono"
                placeholder={t('hooks.commandPlaceholder')}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                data-testid="hooks-command-input"
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
              {t('hooks.addHook')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

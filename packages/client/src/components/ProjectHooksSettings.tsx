import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ProjectHook, HookType } from '@funny/shared';
import { HOOK_TYPES } from '@funny/shared';
import { Editor, type BeforeMount } from '@monaco-editor/react';
import { Plus, Pencil, Trash2, X, Check, GripVertical } from 'lucide-react';
import { useTheme } from 'next-themes';
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

/* ── Inline shell editor (Monaco) ── */

const handleBeforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('funny-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0a0a0a',
      'editorGutter.background': '#0a0a0a',
    },
  });
};

function ShellEditor({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === 'monochrome' ? 'vs' : 'funny-dark';
  const lineCount = Math.max(value.split('\n').length, 3);
  const height = Math.min(Math.max(lineCount * 22 + 16, 100), 400);

  return (
    <div className="overflow-hidden rounded-md border border-input" data-testid={testId}>
      <Editor
        height={height}
        language="shell"
        theme={monacoTheme}
        beforeMount={handleBeforeMount}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 0,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { vertical: 'auto', horizontal: 'hidden', verticalScrollbarSize: 8 },
          renderLineHighlight: 'none',
          padding: { top: 6, bottom: 6 },
        }}
      />
    </div>
  );
}

/** Unique key for a hook command (hookType + index) */
function hookKey(hook: ProjectHook): string {
  return `${hook.hookType}:${hook.index}`;
}

/* ── Draggable hook row ── */
function HookItem({
  hook,
  onEdit,
  onDelete,
  onToggleEnabled,
  t,
}: {
  hook: ProjectHook;
  onEdit: (hook: ProjectHook) => void;
  onDelete: (hook: ProjectHook) => void;
  onToggleEnabled: (hook: ProjectHook) => void;
  t: (key: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const key = hookKey(hook);

  useEffect(() => {
    const el = ref.current;
    const handle = handleRef.current;
    if (!el || !handle) return;

    const cleanupDrag = draggable({
      element: el,
      dragHandle: handle,
      getInitialData: () => ({
        type: 'hook-item',
        key,
        hookType: hook.hookType,
        index: hook.index,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    const cleanupDrop = dropTargetForElements({
      element: el,
      getData: () => ({ type: 'hook-item', key, hookType: hook.hookType, index: hook.index }),
      canDrop: ({ source }) =>
        source.data.type === 'hook-item' &&
        source.data.key !== key &&
        source.data.hookType === hook.hookType,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: () => setIsDropTarget(false),
    });

    return () => {
      cleanupDrag();
      cleanupDrop();
    };
  }, [key, hook.hookType, hook.index]);

  return (
    <div
      ref={ref}
      data-testid={`hook-item-${key}`}
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
        data-testid={`hook-drag-${key}`}
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
                data-testid={`hook-toggle-${key}`}
                size="xs"
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
                data-testid={`hook-edit-${key}`}
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
                onClick={() => onDelete(hook)}
                className="text-muted-foreground hover:text-status-error"
                data-testid={`hook-delete-${key}`}
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
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [hookType, setHookType] = useState<HookType>('pre-commit');
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

        const sourceHookType = source.data.hookType as HookType;
        const sourceIndex = source.data.index as number;
        const targetIndex = targets[0].data.index as number;
        if (sourceIndex === targetIndex || sourceHookType !== targets[0].data.hookType) return;

        setHooks((prev) => {
          // Get hooks of this type
          const typeHooks = prev.filter((h) => h.hookType === sourceHookType);
          const others = prev.filter((h) => h.hookType !== sourceHookType);

          const oldIdx = typeHooks.findIndex((h) => h.index === sourceIndex);
          const newIdx = typeHooks.findIndex((h) => h.index === targetIndex);
          if (oldIdx === -1 || newIdx === -1) return prev;

          const reordered = [...typeHooks];
          const [moved] = reordered.splice(oldIdx, 1);
          reordered.splice(newIdx, 0, moved);

          // Persist reorder
          if (selectedProjectId) {
            const newOrder = reordered.map((h) => h.index);
            api.reorderHooks(selectedProjectId, sourceHookType, newOrder);
          }

          // Update indexes
          const updated = reordered.map((h, i) => ({ ...h, index: i }));
          return [...others, ...updated];
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

  const handleUpdate = async (hook: ProjectHook) => {
    if (!selectedProjectId) return;
    if (!label.trim()) {
      toast.error(t('hooks.labelRequired'));
      return;
    }
    if (!command.trim()) {
      toast.error(t('hooks.commandRequired'));
      return;
    }
    const result = await api.updateHook(selectedProjectId, hook.hookType, hook.index, {
      hookType,
      label: label.trim(),
      command: command.trim(),
    });
    if (result.isOk()) {
      setEditingKey(null);
      resetForm();
      loadHooks();
      toast.success(t('hooks.hookUpdated'));
    } else {
      toast.error(t('hooks.hookUpdateError'));
    }
  };

  const handleDelete = async (hook: ProjectHook) => {
    if (!selectedProjectId) return;
    const result = await api.deleteHook(selectedProjectId, hook.hookType, hook.index);
    if (result.isOk()) {
      loadHooks();
      toast.success(t('hooks.hookDeleted'));
    } else {
      toast.error(t('hooks.hookDeleteError'));
    }
  };

  const handleToggleEnabled = async (hook: ProjectHook) => {
    if (!selectedProjectId) return;
    const result = await api.updateHook(selectedProjectId, hook.hookType, hook.index, {
      enabled: !hook.enabled,
    });
    if (result.isOk()) {
      loadHooks();
    }
  };

  const startEditing = (hook: ProjectHook) => {
    setEditingKey(hookKey(hook));
    setHookType(hook.hookType);
    setLabel(hook.label);
    setCommand(hook.command);
    setAdding(false);
  };

  const resetForm = () => {
    setHookType('pre-commit');
    setLabel('');
    setCommand('');
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setAdding(false);
    resetForm();
  };

  const hookTypeLabelFn = (type: string) => {
    const key = `hooks.${type}` as const;
    return t(key);
  };

  // Group hooks by type
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
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
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
            const key = hookKey(hook);
            if (editingKey === key) {
              return (
                <div key={key} data-testid={`hook-item-${key}`} className="settings-form-panel">
                  <div>
                    <label className="settings-label">{t('hooks.hookType')}</label>
                    <Select value={hookType} onValueChange={(v) => setHookType(v as HookType)}>
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
                  <div>
                    <label className="settings-label">{t('hooks.label')}</label>
                    <Input
                      className="settings-form-input"
                      placeholder={t('hooks.label')}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      data-testid="hooks-label-input"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="settings-label">{t('hooks.command')}</label>
                    <ShellEditor
                      value={command}
                      onChange={setCommand}
                      testId="hooks-command-input"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>
                      <X className="mr-1 h-3.5 w-3.5" />
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" onClick={() => handleUpdate(hook)}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              );
            }

            return (
              <HookItem
                key={key}
                hook={hook}
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
        <div className="settings-form-panel">
          <div>
            <label className="settings-label">{t('hooks.hookType')}</label>
            <Select value={hookType} onValueChange={(v) => setHookType(v as HookType)}>
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
          <div>
            <label className="settings-label">{t('hooks.label')}</label>
            <Input
              className="settings-form-input"
              placeholder={t('hooks.label')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="hooks-label-input"
              autoFocus
            />
          </div>
          <div>
            <label className="settings-label">{t('hooks.command')}</label>
            <ShellEditor value={command} onChange={setCommand} testId="hooks-command-input" />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleAdd}>
              <Check className="mr-1 h-3.5 w-3.5" />
              {t('hooks.addHook')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

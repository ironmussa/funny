import type { ProjectHook, HookType } from '@funny/shared';
import { HOOK_TYPES } from '@funny/shared';
import { Plus } from 'lucide-react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { HookForm } from '@/components/project-hooks-settings/HookForm';
import { HookItem, hookKey } from '@/components/project-hooks-settings/HookItem';
import { useHookReorderMonitor } from '@/components/project-hooks-settings/use-hook-reorder-monitor';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

export function ProjectHooksSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
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
    if (!selectedProjectId) return;
    void api.listHooks(selectedProjectId).then((result) => {
      if (result.isOk()) setHooks(result.value);
    });
  }, [selectedProjectId]);

  // Drag-and-drop reorder monitor
  useHookReorderMonitor(selectedProjectId, setHooks);

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
    return <EmptyState padding="md" fill={false} title={t('hooks.noHooks')} />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          gap="snug"
          data-testid="hooks-add"
          onClick={() => {
            cancelEdit();
            setAdding(true);
          }}
        >
          <Plus className="icon-sm" />
          {t('hooks.addHook')}
        </Button>
      </div>

      {/* Empty state */}
      {hooks.length === 0 && !adding && (
        <EmptyState
          padding="md"
          fill={false}
          title={t('hooks.noHooks')}
          action={
            <Button variant="outline" size="sm" gap="snug" onClick={() => setAdding(true)}>
              <Plus className="icon-sm" />
              {t('hooks.addFirst')}
            </Button>
          }
        />
      )}

      {/* Hook list grouped by type */}
      {hookGroups.map(([type, groupHooks]) => (
        <div key={type} className="space-y-2">
          <h3 className="text-muted-foreground px-1 text-sm font-semibold">
            {hookTypeLabelFn(type)}
          </h3>
          {groupHooks.map((hook) => {
            const key = hookKey(hook);
            if (editingKey === key) {
              return (
                <HookForm
                  key={key}
                  idPrefix="hooks-edit"
                  testId={`hook-item-${key}`}
                  hookType={hookType}
                  setHookType={setHookType}
                  label={label}
                  setLabel={setLabel}
                  command={command}
                  setCommand={setCommand}
                  hookTypeLabelFn={hookTypeLabelFn}
                  onCancel={cancelEdit}
                  onSubmit={() => handleUpdate(hook)}
                  submitLabel={t('common.save')}
                />
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
        <HookForm
          idPrefix="hooks-add"
          hookType={hookType}
          setHookType={setHookType}
          label={label}
          setLabel={setLabel}
          command={command}
          setCommand={setCommand}
          hookTypeLabelFn={hookTypeLabelFn}
          onCancel={cancelEdit}
          onSubmit={handleAdd}
          submitLabel={t('hooks.addHook')}
        />
      )}
    </div>
  );
}

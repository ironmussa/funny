import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ProjectHook } from '@funny/shared';
import { Pencil, Trash2, GripVertical } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

import { CommandHighlight } from '@/components/CommandHighlight';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Unique key for a hook command (hookType + index) */
export function hookKey(hook: ProjectHook): string {
  return `${hook.hookType}:${hook.index}`;
}

/* ── Draggable hook row ── */
export function HookItem({
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
        className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing"
        data-testid={`hook-drag-${key}`}
      >
        <GripVertical className="icon-sm" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{hook.label}</span>
        <CommandHighlight command={hook.command} />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Switch
                checked={hook.enabled}
                onCheckedChange={() => onToggleEnabled(hook)}
                data-testid={`hook-toggle-${key}`}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>{hook.enabled ? t('hooks.enabled') : t('hooks.disabled')}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted"
                size="icon-xs"
                onClick={() => onEdit(hook)}
                data-testid={`hook-edit-${key}`}
              >
                <Pencil className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('hooks.edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted-destructive"
                size="icon-xs"
                onClick={() => onDelete(hook)}
                data-testid={`hook-delete-${key}`}
              >
                <Trash2 className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('hooks.delete')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

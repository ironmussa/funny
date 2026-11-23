import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { X } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { TerminalTab } from '@/stores/terminal-store';

export const TAB_DRAG_TYPE = 'terminal-tab';

interface DraggableTerminalTabProps {
  tab: TerminalTab;
  index: number;
  active: boolean;
  sessionsChecked: boolean;
  onActivate: () => void;
  onClose: () => void;
  onKill: () => void;
  onRename: (label: string) => void;
}

export function DraggableTerminalTab({
  tab,
  index,
  active,
  sessionsChecked,
  onActivate,
  onClose,
  onKill,
  onRename,
}: DraggableTerminalTabProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(tab.label);

  const startRename = useCallback(() => {
    setDraftLabel(tab.label);
    setIsEditing(true);
  }, [tab.label]);

  const commitRename = useCallback(() => {
    const trimmed = draftLabel.trim();
    if (trimmed && trimmed !== tab.label) onRename(trimmed);
    setIsEditing(false);
  }, [draftLabel, tab.label, onRename]);

  const cancelRename = useCallback(() => {
    setDraftLabel(tab.label);
    setIsEditing(false);
  }, [tab.label]);

  const onOutsidePointerDown = useEffectEvent((event: PointerEvent) => {
    const input = inputRef.current;
    if (!input) return;
    if (event.target instanceof Node && input.contains(event.target)) return;
    cancelRename();
  });

  useEffect(() => {
    if (!isEditing) return;
    const handlePointerDown = (event: PointerEvent) => onOutsidePointerDown(event);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isEditing]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({
          type: TAB_DRAG_TYPE,
          tabId: tab.id,
          projectId: tab.projectId,
          index,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          source.data.type === TAB_DRAG_TYPE && source.data.projectId === tab.projectId,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: TAB_DRAG_TYPE, tabId: tab.id, projectId: tab.projectId, index },
            { input, element, allowedEdges: ['left', 'right'] },
          ),
        getIsSticky: () => true,
        onDrag: ({ self, source }) => {
          if (source.data.tabId === tab.id) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [tab.id, tab.projectId, index]);

  const isPty = tab.type === 'pty';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={ref}
          onClick={onActivate}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
          className={cn(
            'relative flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap',
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50',
            isDragging && 'opacity-40',
          )}
          data-testid={`terminal-tab-${tab.id}`}
        >
          {tab.hasBell && !active && (
            <span
              className="bg-status-warning size-1.5 animate-pulse rounded-full"
              data-testid={`terminal-tab-bell-${tab.id}`}
            />
          )}
          {isEditing ? (
            <Input
              ref={inputRef}
              autoFocus
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) {
                  e.stopPropagation();
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 w-32 px-1 py-0 text-xs"
              data-testid={`terminal-tab-rename-${tab.id}`}
            />
          ) : (
            <span>{tab.label}</span>
          )}
          {!tab.alive && (sessionsChecked || !tab.type || tab.type !== 'pty') && (
            <span className="text-status-pending text-xs">{t('terminal.exited')}</span>
          )}
          <X
            className="icon-xs ml-1 opacity-60 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          />
          {closestEdge && (
            <span
              className={cn(
                'pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary',
                closestEdge === 'left' ? '-left-px' : '-right-px',
              )}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => startRename()}
          data-testid={`terminal-tab-context-rename-${tab.id}`}
        >
          {t('terminal.rename')}
        </ContextMenuItem>
        {isPty && tab.alive && (
          <ContextMenuItem
            onSelect={() => onKill()}
            className="text-destructive focus:text-destructive"
            data-testid={`terminal-tab-context-kill-${tab.id}`}
          >
            {t('terminal.kill')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onClose()}
          data-testid={`terminal-tab-context-close-${tab.id}`}
        >
          {t('terminal.close')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

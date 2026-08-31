import { useGpuix } from '@gpuix/react';
import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import {
  Children,
  createContext,
  isValidElement,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  isPrimaryDockDrag,
  moveDock,
  normalizeDockLayout,
  resizeDockPair,
  type DockLayoutState,
  type DockOrientation,
  type DockPanelConstraints,
} from './dock-layout-model';
import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
type Bounds = [number, number, number, number];
type DockPublicInstance = { id: number };

interface DockPanelDefinition extends DockPanelConstraints {
  element: ReactElement<DockPanelProps>;
}

interface DockDragState {
  kind: 'move';
  panelId: string;
  targetId: string;
  placement: 'before' | 'after';
}

interface DockResizeState {
  kind: 'resize';
  leadingId: string;
  trailingId: string;
  startCoordinate: number;
  leadingSize: number;
  trailingSize: number;
  leadingIsFixed: boolean;
  trailingIsFixed: boolean;
}

type DockGesture = DockDragState | DockResizeState;

interface DockContextValue {
  orientation: DockOrientation;
  layout: DockLayoutState;
  gesture: DockGesture | null;
  panelRefs: Map<string, DockPublicInstance>;
  definitions: Map<string, DockPanelDefinition>;
  beginMove(panelId: string): void;
  beginResize(leadingId: string, trailingId: string, event: EventPayload): void;
  moveGesture(event: EventPayload): void;
  finishGesture(): void;
}

const DockContext = createContext<DockContextValue | null>(null);
const DockPanelContext = createContext<string | null>(null);

export interface DockLayoutRootProps extends Omit<DivProps, 'children' | 'style'> {
  children: ReactNode;
  orientation?: DockOrientation;
  value?: DockLayoutState;
  defaultValue?: Partial<DockLayoutState>;
  onValueChange?: (value: DockLayoutState) => void;
  onValueCommit?: (value: DockLayoutState) => void;
  style?: StyleDesc;
}

export function DockLayoutRoot({
  children,
  orientation = 'horizontal',
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  style,
  ...props
}: DockLayoutRootProps): ReactElement {
  const theme = useGpuixUiTheme();
  const { renderer } = useGpuix();
  const definitions = useMemo(() => collectDockPanels(children), [children]);
  const constraints = useMemo(
    () => definitions.map(({ element: _element, ...definition }) => definition),
    [definitions],
  );
  const [internalLayout, setInternalLayout] = useState(() =>
    normalizeDockLayout(constraints, defaultValue),
  );
  const layout = normalizeDockLayout(constraints, value ?? internalLayout);
  const [gesture, setGesture] = useState<DockGesture | null>(null);
  const layoutRef = useRef(layout);
  const gestureRef = useRef<DockGesture | null>(null);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  const panelRefs = useRef(new Map<string, DockPublicInstance>()).current;
  const definitionMap = useMemo(
    () => new Map(definitions.map((definition) => [definition.id, definition])),
    [definitions],
  );

  const updateLayout = useCallback(
    (update: (current: DockLayoutState) => DockLayoutState) => {
      const next = update(layoutRef.current);
      layoutRef.current = next;
      if (value === undefined) setInternalLayout(next);
      onValueChange?.(next);
    },
    [onValueChange, value],
  );

  const updateGesture = useCallback((next: DockGesture | null) => {
    gestureRef.current = next;
    setGesture(next);
  }, []);

  const boundsFor = useCallback(
    (id: string): Bounds | null => {
      const instance = panelRefs.get(id);
      const bounds = instance
        ? (
            renderer as
              | (typeof renderer & {
                  getElementBounds?(elementId: number): number[] | null;
                })
              | null
          )?.getElementBounds?.(instance.id)
        : null;
      return bounds && bounds.length >= 4 ? (bounds.slice(0, 4) as Bounds) : null;
    },
    [panelRefs, renderer],
  );

  const beginMove = useCallback(
    (panelId: string) => {
      updateGesture({ kind: 'move', panelId, targetId: panelId, placement: 'before' });
    },
    [updateGesture],
  );

  const beginResize = useCallback(
    (leadingId: string, trailingId: string, event: EventPayload) => {
      const leadingBounds = boundsFor(leadingId);
      const trailingBounds = boundsFor(trailingId);
      const coordinate = orientation === 'horizontal' ? event.x : event.y;
      if (!leadingBounds || !trailingBounds || coordinate === undefined) return;
      updateGesture({
        kind: 'resize',
        leadingId,
        trailingId,
        startCoordinate: coordinate,
        leadingSize: orientation === 'horizontal' ? leadingBounds[2] : leadingBounds[3],
        trailingSize: orientation === 'horizontal' ? trailingBounds[2] : trailingBounds[3],
        leadingIsFixed: layoutRef.current.sizes[leadingId] !== undefined,
        trailingIsFixed: layoutRef.current.sizes[trailingId] !== undefined,
      });
    },
    [boundsFor, orientation, updateGesture],
  );

  const finishGesture = useCallback(() => {
    const activeGesture = gestureRef.current;
    if (!activeGesture) return;
    updateGesture(null);
    const currentLayout = layoutRef.current;
    if (activeGesture.kind === 'move' && activeGesture.panelId !== activeGesture.targetId) {
      const next = {
        ...currentLayout,
        order: moveDock(
          currentLayout.order,
          activeGesture.panelId,
          activeGesture.targetId,
          activeGesture.placement,
        ),
      };
      updateLayout(() => next);
      onValueCommit?.(next);
    } else if (activeGesture.kind === 'resize') {
      onValueCommit?.(currentLayout);
    }
  }, [onValueCommit, updateGesture, updateLayout]);

  const moveGesture = useCallback(
    (event: EventPayload) => {
      const activeGesture = gestureRef.current;
      if (!activeGesture) return;
      if (!isPrimaryDockDrag(event.pressedButton)) {
        finishGesture();
        return;
      }
      const coordinate = orientation === 'horizontal' ? event.x : event.y;
      if (coordinate === undefined) return;
      if (activeGesture.kind === 'resize') {
        const leading = definitionMap.get(activeGesture.leadingId);
        const trailing = definitionMap.get(activeGesture.trailingId);
        if (!leading || !trailing) return;
        const resized = resizeDockPair({
          leading,
          trailing,
          leadingSize: activeGesture.leadingSize,
          trailingSize: activeGesture.trailingSize,
          leadingIsFixed: activeGesture.leadingIsFixed,
          trailingIsFixed: activeGesture.trailingIsFixed,
          delta: coordinate - activeGesture.startCoordinate,
        });
        updateLayout((current) => ({ ...current, sizes: { ...current.sizes, ...resized } }));
        return;
      }

      let closest: { id: string; distance: number; placement: 'before' | 'after' } | null = null;
      for (const id of layoutRef.current.order) {
        if (id === activeGesture.panelId) continue;
        const bounds = boundsFor(id);
        if (!bounds) continue;
        const start = orientation === 'horizontal' ? bounds[0] : bounds[1];
        const size = orientation === 'horizontal' ? bounds[2] : bounds[3];
        const center = start + size / 2;
        const candidate = {
          id,
          distance: Math.abs(coordinate - center),
          placement: coordinate < center ? ('before' as const) : ('after' as const),
        };
        if (!closest || candidate.distance < closest.distance) closest = candidate;
      }
      if (
        closest &&
        (closest.id !== activeGesture.targetId || closest.placement !== activeGesture.placement)
      ) {
        updateGesture({
          ...activeGesture,
          targetId: closest.id,
          placement: closest.placement,
        });
      }
    },
    [boundsFor, definitionMap, finishGesture, orientation, updateGesture, updateLayout],
  );

  const context = useMemo<DockContextValue>(
    () => ({
      orientation,
      layout,
      gesture,
      panelRefs,
      definitions: definitionMap,
      beginMove,
      beginResize,
      moveGesture,
      finishGesture,
    }),
    [
      beginMove,
      beginResize,
      definitionMap,
      finishGesture,
      gesture,
      layout,
      moveGesture,
      orientation,
      panelRefs,
    ],
  );
  const orderedPanels = layout.order.flatMap((id) => {
    const definition = definitionMap.get(id);
    return definition ? [definition.element] : [];
  });

  return (
    <DockContext value={context}>
      <div
        {...props}
        style={{
          display: 'flex',
          flexDirection: orientation === 'horizontal' ? 'row' : 'column',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          backgroundColor: theme.colors.background,
          ...style,
        }}
      >
        {orderedPanels.flatMap((panel, index) => {
          const panelId = panel.props.id;
          const previousId = index > 0 ? orderedPanels[index - 1]?.props.id : undefined;
          return [
            previousId ? (
              <DockSeparator
                key={`separator:${previousId}:${panelId}`}
                leadingId={previousId}
                trailingId={panelId}
              />
            ) : null,
            panel,
          ];
        })}
        {gesture ? (
          <div
            testId="dock-drag-capture"
            onMouseDown={finishGesture}
            onMouseMove={moveGesture}
            onMouseUp={finishGesture}
            onMouseLeave={finishGesture}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              pointerEvents: 'auto',
              backgroundColor: '#00000001',
              cursor:
                gesture.kind === 'move'
                  ? 'grabbing'
                  : orientation === 'horizontal'
                    ? 'col-resize'
                    : 'row-resize',
              userSelect: 'none',
            }}
          />
        ) : null}
      </div>
    </DockContext>
  );
}

export interface DockPanelProps extends Omit<DivProps, 'style'> {
  id: string;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  style?: StyleDesc;
}

export function DockPanel({
  id,
  defaultSize: _defaultSize,
  minSize: _minSize,
  maxSize: _maxSize,
  style,
  ...props
}: DockPanelProps): ReactElement {
  const context = useDockContext();
  const fixedSize = context.layout.sizes[id];
  const dropTarget = context.gesture?.kind === 'move' && context.gesture.targetId === id;
  const axisStyle: StyleDesc =
    context.orientation === 'horizontal'
      ? fixedSize === undefined
        ? { flexGrow: 1, flexBasis: 0, minWidth: 0 }
        : { width: fixedSize, minWidth: 0, flexShrink: 0 }
      : fixedSize === undefined
        ? { flexGrow: 1, flexBasis: 0, minHeight: 0 }
        : { height: fixedSize, minHeight: 0, flexShrink: 0 };
  return (
    <DockPanelContext value={id}>
      <div
        {...props}
        ref={(instance) => {
          if (instance) context.panelRefs.set(id, instance);
          else context.panelRefs.delete(id);
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          ...axisStyle,
          ...(dropTarget ? { opacity: 0.76 } : null),
          ...style,
        }}
      />
    </DockPanelContext>
  );
}

export interface DockHandleProps extends Omit<DivProps, 'style'> {
  style?: StyleDesc;
}

export function DockHandle({ style, children, ...props }: DockHandleProps): ReactElement {
  const context = useDockContext();
  const panelId = use(DockPanelContext);
  const theme = useGpuixUiTheme();
  if (!panelId) throw new Error('DockHandle must be rendered inside DockPanel');
  const moving = context.gesture?.kind === 'move' && context.gesture.panelId === panelId;
  return (
    <div
      {...props}
      onMouseDown={(event) => {
        if (event.button === undefined || event.button === 0) context.beginMove(panelId);
        props.onMouseDown?.(event);
      }}
      onMouseMove={(event) => {
        context.moveGesture(event);
        props.onMouseMove?.(event);
      }}
      onMouseUp={(event) => {
        context.finishGesture();
        props.onMouseUp?.(event);
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        minHeight: 18,
        gap: 6,
        paddingLeft: 8,
        paddingRight: 8,
        color: theme.colors.muted,
        backgroundColor: theme.colors.panel,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        cursor: moving ? 'grabbing' : 'grab',
        userSelect: 'none',
        ...style,
      }}
    >
      <text style={{ color: theme.colors.muted, fontSize: 10 }}>•••</text>
      {children}
    </div>
  );
}

interface DockSeparatorProps {
  leadingId: string;
  trailingId: string;
}

function DockSeparator({ leadingId, trailingId }: DockSeparatorProps): ReactElement {
  const context = useDockContext();
  const theme = useGpuixUiTheme();
  const horizontal = context.orientation === 'horizontal';
  const resizing =
    context.gesture?.kind === 'resize' &&
    context.gesture.leadingId === leadingId &&
    context.gesture.trailingId === trailingId;
  return (
    <div
      testId={`dock-separator-${leadingId}-${trailingId}`}
      onMouseDown={(event) => {
        if (event.button === undefined || event.button === 0) {
          context.beginResize(leadingId, trailingId, event);
        }
      }}
      onMouseMove={(event) => {
        context.moveGesture(event);
      }}
      onMouseUp={() => {
        context.finishGesture();
      }}
      style={{
        flexShrink: 0,
        width: horizontal ? 7 : '100%',
        height: horizontal ? '100%' : 7,
        padding: 3,
        backgroundColor: resizing ? theme.colors.accent : theme.colors.background,
        borderColor: theme.colors.borderStrong,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          width: horizontal ? 1 : '100%',
          height: horizontal ? '100%' : 1,
          backgroundColor: resizing ? theme.colors.accent : theme.colors.borderStrong,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

function useDockContext(): DockContextValue {
  const context = use(DockContext);
  if (!context) throw new Error('Dock components must be rendered inside DockLayout.Root');
  return context;
}

function collectDockPanels(children: ReactNode): DockPanelDefinition[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<DockPanelProps>(child) || child.type !== DockPanel) return [];
    return [
      {
        id: child.props.id,
        defaultSize: child.props.defaultSize,
        minSize: child.props.minSize ?? 160,
        maxSize: child.props.maxSize,
        element: child,
      },
    ];
  });
}

export const DockLayout = {
  Root: DockLayoutRoot,
  Panel: DockPanel,
  Handle: DockHandle,
};

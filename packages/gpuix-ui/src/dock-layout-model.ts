export type DockOrientation = 'horizontal' | 'vertical';

export interface DockLayoutState {
  order: string[];
  sizes: Record<string, number>;
}

export interface DockPanelConstraints {
  id: string;
  defaultSize?: number;
  minSize: number;
  maxSize?: number;
}

export interface DockResizeInput {
  leading: DockPanelConstraints;
  trailing: DockPanelConstraints;
  leadingSize: number;
  trailingSize: number;
  leadingIsFixed: boolean;
  trailingIsFixed: boolean;
  delta: number;
}

export function isPrimaryDockDrag(pressedButton: number | undefined): boolean {
  return pressedButton === undefined || pressedButton === 0;
}

const finitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function normalizeDockLayout(
  panels: readonly DockPanelConstraints[],
  value?: Partial<DockLayoutState>,
): DockLayoutState {
  const panelIds = new Set(panels.map((panel) => panel.id));
  const order: string[] = [];
  const orderedIds = new Set<string>();
  for (const id of value?.order ?? []) {
    if (panelIds.has(id) && !orderedIds.has(id)) {
      order.push(id);
      orderedIds.add(id);
    }
  }
  for (const panel of panels) {
    if (!orderedIds.has(panel.id)) {
      order.push(panel.id);
      orderedIds.add(panel.id);
    }
  }

  const sizes: Record<string, number> = {};
  for (const panel of panels) {
    const requested = value?.sizes?.[panel.id] ?? panel.defaultSize;
    if (!finitePositive(requested)) continue;
    sizes[panel.id] = clampDockSize(requested, panel);
  }
  return { order, sizes };
}

export function moveDock(
  order: readonly string[],
  activeId: string,
  targetId: string,
  placement: 'before' | 'after',
): string[] {
  if (activeId === targetId || !order.includes(activeId) || !order.includes(targetId)) {
    return [...order];
  }
  const next = order.filter((id) => id !== activeId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, activeId);
  return next;
}

export function resizeDockPair(input: DockResizeInput): Record<string, number> {
  const pairSize = input.leadingSize + input.trailingSize;
  const leadingMaximum = Math.min(
    input.leading.maxSize ?? Number.POSITIVE_INFINITY,
    pairSize - input.trailing.minSize,
  );
  const trailingMaximum = Math.min(
    input.trailing.maxSize ?? Number.POSITIVE_INFINITY,
    pairSize - input.leading.minSize,
  );

  if (input.leadingIsFixed && !input.trailingIsFixed) {
    return {
      [input.leading.id]: clamp(
        input.leadingSize + input.delta,
        input.leading.minSize,
        leadingMaximum,
      ),
    };
  }
  if (!input.leadingIsFixed && input.trailingIsFixed) {
    return {
      [input.trailing.id]: clamp(
        input.trailingSize - input.delta,
        input.trailing.minSize,
        trailingMaximum,
      ),
    };
  }

  const leadingSize = clamp(input.leadingSize + input.delta, input.leading.minSize, leadingMaximum);
  return {
    [input.leading.id]: leadingSize,
    [input.trailing.id]: pairSize - leadingSize,
  };
}

function clampDockSize(value: number, panel: DockPanelConstraints): number {
  return clamp(value, panel.minSize, panel.maxSize ?? Number.POSITIVE_INFINITY);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

import type { DockviewGroupPanel, IDockviewHeaderActionsProps } from 'dockview-react';
import { type ReactNode, createContext, useContext, useLayoutEffect } from 'react';

type HeaderActionsRef = { current: ReactNode };

type BottomHeaderActionsContextValue = {
  prefix: HeaderActionsRef;
  left: HeaderActionsRef;
  right: HeaderActionsRef;
};

const BottomHeaderActionsContext = createContext<BottomHeaderActionsContextValue | null>(null);

/** Makes the bottom group's header actions (read through refs at render time)
 *  available to the header-action renderers below. */
export function BottomHeaderActionsProvider({
  value,
  children,
}: {
  value: BottomHeaderActionsContextValue;
  children: ReactNode;
}) {
  return (
    <BottomHeaderActionsContext.Provider value={value}>
      {children}
    </BottomHeaderActionsContext.Provider>
  );
}

/** Marks the bottom group's root `.groupview` element with `data-bottom-group`
 *  so CSS can target the terminal tab bar background independently. */
function BottomGroupMarker({
  group,
  children,
}: {
  group: DockviewGroupPanel;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const el = group.element;
    if (!el) return;
    el.setAttribute('data-bottom-group', '');
    return () => el.removeAttribute('data-bottom-group');
  }, [group]);
  return <>{children}</>;
}

function useBottomHeaderActions() {
  const actions = useContext(BottomHeaderActionsContext);
  if (!actions) {
    throw new Error('Bottom header actions must be rendered within DockviewLayout');
  }
  return actions;
}

export function PrefixHeaderActions({ group }: IDockviewHeaderActionsProps) {
  const actions = useBottomHeaderActions();
  if (!isBottomGroup(group)) return null;
  return <BottomGroupMarker group={group}>{actions.prefix.current ?? null}</BottomGroupMarker>;
}

export function LeftHeaderActions({ group }: IDockviewHeaderActionsProps) {
  const actions = useBottomHeaderActions();
  if (!isBottomGroup(group)) return null;
  return <>{actions.left.current ?? null}</>;
}

export function RightHeaderActions({ group }: IDockviewHeaderActionsProps) {
  const actions = useBottomHeaderActions();
  if (!isBottomGroup(group)) return null;
  return <>{actions.right.current ?? null}</>;
}

function isBottomGroup(group: DockviewGroupPanel): boolean {
  return group.panels.some((p) => p.id.startsWith('bottom:'));
}

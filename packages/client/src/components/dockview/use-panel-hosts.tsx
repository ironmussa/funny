import type { IDockviewPanelProps } from 'dockview-react';
import { type FunctionComponent, useCallback, useMemo, useState } from 'react';

import { PanelHost, RightTabHeader } from './PanelHost';

/**
 * DOM hosts for dockview panels plus the component maps that create them.
 * `staticIds` get one renderer each (host id = component id); `dynamicIds`
 * are renderers shared by many panels, whose host id comes from the panel's
 * `hostId` param. Pass module-level arrays so the maps stay stable.
 */
export function usePanelHosts(staticIds: readonly string[], dynamicIds: readonly string[]) {
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({});

  const setHostRef = useCallback((id: string, el: HTMLElement | null) => {
    setHosts((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }));
  }, []);

  // ── Component & tab renderers ──
  const components = useMemo(() => {
    const make = (id: string) => () => <PanelHost id={id} onMount={setHostRef} />;
    const dynamicRenderer = (props: IDockviewPanelProps<{ hostId?: string }>) => {
      const hostId = props.params?.hostId ?? props.api.id;
      return <PanelHost id={hostId} onMount={setHostRef} />;
    };
    const map: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
    for (const id of staticIds) map[id] = make(id);
    for (const id of dynamicIds) map[id] = dynamicRenderer;
    return map;
  }, [dynamicIds, setHostRef, staticIds]);

  // Custom tab component for right-pane tabs: title only, no close button.
  // Terminal tabs use dockview's default tab (with X) by NOT setting tabComponent.
  const tabComponents = useMemo(
    () => ({
      'right-tab': RightTabHeader,
    }),
    [],
  );

  return { hosts, components, tabComponents };
}

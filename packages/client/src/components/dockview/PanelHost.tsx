import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useCallback } from 'react';

/** Empty DOM host a dockview panel renders; the panel's React subtree is
 *  portaled into it by the layout. */
export function PanelHost({
  id,
  onMount,
}: {
  id: string;
  onMount: (id: string, el: HTMLElement | null) => void;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => onMount(id, el), [id, onMount]);
  return <div ref={ref} className="h-full w-full overflow-hidden" />;
}

/** Tab renderer for right-pane tabs — title only, no close button. */
export function RightTabHeader(props: IDockviewPanelHeaderProps) {
  return (
    <div className="dv-funny-right-tab text-compact flex h-full items-center px-2.5 font-medium">
      {props.api.title}
    </div>
  );
}

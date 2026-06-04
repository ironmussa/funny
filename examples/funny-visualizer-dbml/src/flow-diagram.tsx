import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
// Bundled as text via esbuild `--loader:.css=text`, then injected once at
// runtime (a dynamically-imported ESM plugin can't ship a side-loaded CSS file).
import xyflowCss from '@xyflow/react/dist/style.css';
import { useCallback, useEffect, type CSSProperties, type ReactNode } from 'react';

import { DbmlSchemaNode, type DbmlTableNodeData } from './schema-node';

const cn = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' ');

const STYLE_ID = 'funny-visualizer-dbml-xyflow-css';
function ensureXyflowCss(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = xyflowCss as unknown as string;
  document.head.appendChild(el);
}

const nodeTypes = { dbmlTable: DbmlSchemaNode };

const TOOLBAR_BTN =
  'inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground';

function FitViewOnGraphChange({ graphKey }: { graphKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 200 });
    });
    return () => cancelAnimationFrame(id);
  }, [graphKey, fitView]);
  return null;
}

function ZoomToolbar({ testIdPrefix }: { testIdPrefix: string }) {
  const { zoomIn, zoomOut, getZoom, setViewport, getViewport } = useReactFlow();
  const percent = Math.round(getZoom() * 100);

  const resetZoom = useCallback(() => {
    const { x, y } = getViewport();
    void setViewport({ x, y, zoom: 1 }, { duration: 150 });
  }, [getViewport, setViewport]);

  return (
    <>
      <span className="text-muted-foreground px-1 text-xs">{percent}%</span>
      <button
        type="button"
        className={TOOLBAR_BTN}
        onClick={() => zoomOut({ duration: 150 })}
        aria-label="Zoom out"
        title="Zoom out"
        data-testid={`${testIdPrefix}-zoom-out`}
      >
        −
      </button>
      <button
        type="button"
        className={TOOLBAR_BTN}
        onClick={() => zoomIn({ duration: 150 })}
        aria-label="Zoom in"
        title="Zoom in"
        data-testid={`${testIdPrefix}-zoom-in`}
      >
        +
      </button>
      <button
        type="button"
        className={TOOLBAR_BTN}
        onClick={resetZoom}
        aria-label="Reset zoom"
        title="Reset zoom"
        data-testid={`${testIdPrefix}-zoom-reset`}
      >
        1:1
      </button>
    </>
  );
}

function DbmlFlowCanvas({
  nodes,
  edges,
  className,
  style,
  testIdPrefix,
  toolbarExtra,
}: {
  nodes: Node<DbmlTableNodeData>[];
  edges: Edge[];
  className?: string;
  style?: CSSProperties;
  testIdPrefix: string;
  toolbarExtra?: ReactNode;
}) {
  const graphKey = `${nodes.length}-${edges.length}-${nodes[0]?.id ?? ''}`;

  return (
    <div
      className={cn('group relative h-full w-full overflow-hidden bg-card', className)}
      style={style}
      data-testid="dbml-diagram"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="bg-card h-full w-full [&_.react-flow__edge-path]:stroke-[hsl(var(--foreground))]"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="hsl(var(--border))" />
        <FitViewOnGraphChange graphKey={graphKey} />
      </ReactFlow>

      <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <div className="border-border bg-background/90 pointer-events-auto flex items-center gap-1 rounded-md border px-1 py-0.5 shadow-sm backdrop-blur">
          <ZoomToolbar testIdPrefix={testIdPrefix} />
          {toolbarExtra}
        </div>
      </div>
    </div>
  );
}

export function DbmlFlowDiagram({
  nodes,
  edges,
  className,
  style,
  testIdPrefix = 'dbml-inline',
  toolbarExtra,
}: {
  nodes: Node<DbmlTableNodeData>[];
  edges: Edge[];
  className?: string;
  style?: CSSProperties;
  testIdPrefix?: string;
  toolbarExtra?: ReactNode;
}) {
  ensureXyflowCss();
  return (
    <ReactFlowProvider>
      <DbmlFlowCanvas
        nodes={nodes}
        edges={edges}
        className={className}
        style={style}
        testIdPrefix={testIdPrefix}
        toolbarExtra={toolbarExtra}
      />
    </ReactFlowProvider>
  );
}

/** A small ghost toolbar button (expand / minimize / close), glyph-based to
 *  avoid bundling an icon library. */
export function DbmlToolbarButton({
  onClick,
  label,
  testId,
  glyph,
}: {
  onClick: () => void;
  label: string;
  testId: string;
  glyph: string;
}) {
  return (
    <button
      type="button"
      className={TOOLBAR_BTN}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {glyph}
    </button>
  );
}

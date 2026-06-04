// Reference funny visualizer plugin: DBML → interactive ER diagram (React Flow).
//
// Fully decoupled from funny's core — bundles its own @dbml/parse + @xyflow/react
// + @dagrejs/dagre, depends only on the public `react` + `@funny/host` peer
// surface, and styles itself with funny's Tailwind/theme tokens (resolved at
// runtime via CSS variables on :root). Build to ESM with `npm run build`.
import { type VisualizerPlugin, type VisualizerProps } from '@funny/host';
import { useEffect, useMemo, useState } from 'react';

import { dbmlToFlow, type DbmlFlowGraph } from './dbml-to-flow';
import { DbmlFlowDiagram, DbmlToolbarButton } from './flow-diagram';

const DBML_INLINE_HEIGHT = 420;

function useDbmlGraph(source: string): { graph: DbmlFlowGraph | null; error: string } {
  return useMemo(() => {
    try {
      return { graph: dbmlToFlow(source), error: '' };
    } catch (err) {
      return { graph: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [source]);
}

function ExpandedOverlay({ graph, onClose }: { graph: DbmlFlowGraph; onClose: () => void }) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="dbml-expanded-overlay"
    >
      <div
        className={
          fullscreen
            ? 'border-border bg-card flex h-full w-full flex-col overflow-hidden rounded-lg border'
            : 'border-border bg-card flex h-[85vh] w-[90vw] max-w-[1200px] flex-col overflow-hidden rounded-lg border'
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex flex-shrink-0 items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">DBML Diagram</span>
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-6 w-6 items-center justify-center rounded"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            data-testid="dbml-close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1" data-testid="dbml-expanded-diagram">
          <DbmlFlowDiagram
            nodes={graph.nodes}
            edges={graph.edges}
            className="h-full"
            testIdPrefix="dbml"
            toolbarExtra={
              <DbmlToolbarButton
                onClick={() => setFullscreen((p) => !p)}
                label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                testId="dbml-toggle-fullscreen"
                glyph={fullscreen ? '🗕' : '⤢'}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

function DbmlBlock({ source, fill }: VisualizerProps) {
  const { graph, error } = useDbmlGraph(source);
  const [expanded, setExpanded] = useState(false);

  if (error) {
    return (
      <div
        className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded border px-3 py-2 text-xs"
        data-testid="dbml-error"
      >
        <span className="font-medium">Invalid DBML</span>
        <span className="text-muted-foreground">{error}</span>
      </div>
    );
  }

  if (!graph) return null;

  if (fill) {
    return (
      <DbmlFlowDiagram
        nodes={graph.nodes}
        edges={graph.edges}
        className="h-full"
        testIdPrefix="dbml-fill"
      />
    );
  }

  return (
    <>
      <DbmlFlowDiagram
        nodes={graph.nodes}
        edges={graph.edges}
        className="border-border rounded border"
        style={{ height: DBML_INLINE_HEIGHT }}
        testIdPrefix="dbml-inline"
        toolbarExtra={
          <DbmlToolbarButton
            onClick={() => setExpanded(true)}
            label="Expand"
            testId="dbml-inline-expand"
            glyph="⤢"
          />
        }
      />
      {expanded && <ExpandedOverlay graph={graph} onClose={() => setExpanded(false)} />}
    </>
  );
}

const plugin: VisualizerPlugin = {
  id: 'funny-visualizer-dbml',
  version: '0.1.0',
  contributes: { fences: ['dbml'], fileExtensions: ['.dbml'] },
  Component: DbmlBlock,
};

export default plugin;

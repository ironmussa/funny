import { lazy, Suspense } from 'react';

import { registerVisualizer, type VisualizerProps } from '@/lib/visualizer-registry';

// Lazy so each renderer stays out of the boot chunk — this module is imported at
// app boot. Each wrapper carries its own Suspense so consumers can render
// <plugin.Component /> without a boundary.
const MermaidBlock = lazy(() =>
  import('@/components/MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);
const CsvTable = lazy(() => import('@/components/CsvTable').then((m) => ({ default: m.CsvTable })));

function VisualizerFallback() {
  return <div className="h-8 animate-pulse rounded bg-muted/50" />;
}

function MermaidVisualizer({ source }: VisualizerProps) {
  return (
    <Suspense fallback={<VisualizerFallback />}>
      <MermaidBlock chart={source} />
    </Suspense>
  );
}

function CsvVisualizer({ source, fill }: VisualizerProps) {
  return (
    <Suspense fallback={<VisualizerFallback />}>
      <CsvTable source={source} fill={fill} />
    </Suspense>
  );
}

/**
 * Register funny's built-in visualizers. These ship in the base bundle because
 * they're broadly useful and cheap to maintain (Mermaid has one dep and is
 * lazy-loaded; CSV has none). Heavy / niche renderers (e.g. DBML) live as
 * decoupled extensions instead. All built-ins use the exact same host↔plugin
 * contract a third-party extension does. Idempotent.
 */
export function registerBuiltinVisualizers(): void {
  registerVisualizer({
    id: '@funny/visualizer-mermaid',
    version: '1.0.0',
    contributes: { fences: ['mermaid'] },
    Component: MermaidVisualizer,
  });
  registerVisualizer({
    id: '@funny/visualizer-csv',
    version: '1.0.0',
    contributes: { fences: ['csv'], fileExtensions: ['.csv'] },
    Component: CsvVisualizer,
  });
}

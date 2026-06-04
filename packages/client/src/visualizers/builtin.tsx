import { lazy, Suspense } from 'react';

import { registerVisualizer, type VisualizerProps } from '@/lib/visualizer-registry';

// Lazy so the heavy renderer (mermaid) stays out of the boot chunk — this module
// is imported at app boot. Each wrapper carries its own Suspense so consumers
// can render <plugin.Component /> without a boundary.
const MermaidBlock = lazy(() =>
  import('@/components/MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);

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

/**
 * Register funny's built-in visualizers. Mermaid is the reference built-in — it
 * uses the exact same host↔plugin contract a third-party extension does, so it
 * validates the system against code that already works. Idempotent.
 */
export function registerBuiltinVisualizers(): void {
  registerVisualizer({
    id: '@funny/visualizer-mermaid',
    version: '1.0.0',
    contributes: { fences: ['mermaid'] },
    Component: MermaidVisualizer,
  });
}

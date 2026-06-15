import { lazy, Suspense } from 'react';

import { cn } from '@/lib/utils';
import { registerVisualizer, type VisualizerProps } from '@/lib/visualizer-registry';

// Lazy so each renderer stays out of the boot chunk — this module is imported at
// app boot. Each wrapper carries its own Suspense so consumers can render
// <plugin.Component /> without a boundary.
const MermaidBlock = lazy(() =>
  import('@/components/MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);
const CsvTable = lazy(() => import('@/components/CsvTable').then((m) => ({ default: m.CsvTable })));

function VisualizerFallback() {
  return <div className="bg-muted/50 h-8 animate-pulse rounded" />;
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
 * Built-in video preview. A `binary` visualizer: it renders from `src` (the
 * raw-bytes URL the host serves from `/api/files/raw`), since `source` text
 * would be corrupt video bytes. No dependency — a native <video> element — so
 * it ships inline rather than lazy-loaded.
 */
function VideoVisualizer({ src, fill }: VisualizerProps) {
  if (!src) return null;
  return (
    <video
      controls
      src={src}
      data-testid="visualizer-video"
      className={cn('w-full bg-gray-950 object-contain', fill ? 'h-full' : 'max-h-[70vh] rounded')}
    >
      Your browser does not support the video element.
    </video>
  );
}

/**
 * Register funny's built-in visualizers. These ship in the base bundle because
 * they're broadly useful and cheap to maintain (Mermaid has one dep and is
 * lazy-loaded; CSV and video have none). Video is the reference `binary`
 * visualizer — it reads `src` (raw bytes) instead of `source` (text). Heavy /
 * niche renderers (e.g. DBML) live as decoupled extensions instead. All
 * built-ins use the exact same host↔plugin contract a third-party extension
 * does. Idempotent.
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
  // Binary visualizer (reads `src`, not `source`). In the project file tree
  // these extensions hit the richer `MediaPreview` lightbox first; this entry
  // covers the Monaco-dialog path (review-pane changed files, internal editor),
  // where a video would otherwise open as corrupt text.
  registerVisualizer({
    id: '@funny/visualizer-video',
    version: '1.0.0',
    contributes: { fileExtensions: ['.mp4', '.webm', '.mov', '.mkv'], binary: true },
    Component: VideoVisualizer,
  });
}

import { createClientLogger } from '@/lib/client-logger';
import { registerVisualizer, type VisualizerPlugin } from '@/lib/visualizer-registry';

const log = createClientLogger('visualizers');

interface ExtensionManifestEntry {
  id: string;
  version: string;
  entryUrl: string;
}

/** Injectable dynamic import so tests can stub module loading. The
 *  `@vite-ignore` keeps Vite from trying to analyze the runtime URL. */
type ImportFn = (url: string) => Promise<unknown>;
const defaultImport: ImportFn = (url) => import(/* @vite-ignore */ url);

function isVisualizerPlugin(value: unknown): value is VisualizerPlugin {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === 'string' && typeof p.Component === 'function';
}

/**
 * Fetch the installed-extensions manifest and dynamically import + register each
 * visualizer. Resilient by design: a failed fetch or a single broken plugin is
 * logged and skipped — it must never prevent the host (or the other plugins)
 * from working. Call once at boot, AFTER `installVisualizerHostGlobals()` and
 * `registerBuiltinVisualizers()`.
 */
export async function loadInstalledVisualizers(
  fetchFn: typeof fetch = fetch,
  importFn: ImportFn = defaultImport,
): Promise<void> {
  let manifest: ExtensionManifestEntry[];
  try {
    const res = await fetchFn('/api/extensions');
    if (!res.ok) {
      log.warn('extension manifest fetch failed', { status: res.status });
      return;
    }
    manifest = await res.json();
  } catch (err) {
    log.error('extension manifest fetch errored', { error: String(err) });
    return;
  }
  if (!Array.isArray(manifest) || manifest.length === 0) return;

  await Promise.all(
    manifest.map(async (ext) => {
      try {
        const mod = (await importFn(ext.entryUrl)) as { default?: unknown; plugin?: unknown };
        const candidate = mod.default ?? mod.plugin;
        if (!isVisualizerPlugin(candidate)) {
          log.error('extension did not export a valid visualizer plugin', { id: ext.id });
          return;
        }
        registerVisualizer(candidate);
        log.info('loaded installed visualizer', { id: candidate.id, version: candidate.version });
      } catch (err) {
        log.error('failed to load installed visualizer', { id: ext.id, error: String(err) });
      }
    }),
  );
}

// ─── Visualizers ─────────────────────────────────────────
//
// The *serializable* half of the visualizer-plugin contract. Lives in
// `@funny/shared` so the host client, the server (extension discovery /
// `GET /api/extensions`), and third-party plugin authors all share one
// definition. The React-bound half (`VisualizerProps`, `VisualizerPlugin`
// with its `Component`) lives in `@funny/host` — `react` is not resolvable
// from this package, and the over-the-wire manifest is JSON, so the component
// binding deliberately does not belong here.

/** What a visualizer claims to handle. */
export interface VisualizerContributes {
  /** Fenced code langs it renders, e.g. `['mermaid']` for ```mermaid blocks. */
  fences?: string[];
  /** File extensions that enable a preview, e.g. `['.csv']`. Leading dot optional. */
  fileExtensions?: string[];
}

/** The serializable identity + capabilities of a visualizer plugin. */
export interface VisualizerManifest {
  /** Stable plugin id, e.g. `@funny/visualizer-mermaid`. */
  id: string;
  version: string;
  contributes: VisualizerContributes;
}

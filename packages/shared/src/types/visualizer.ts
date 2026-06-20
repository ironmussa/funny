// ─── Visualizers ─────────────────────────────────────────
//
// The *serializable* half of the visualizer-plugin contract. Lives in
// `@funny/shared` so the host client, the server (extension discovery /
// `GET /api/extensions`), and third-party plugin authors all share one
// definition. The React-bound half (`VisualizerProps`, `VisualizerPlugin`
// with its `Component`) lives in `@funny/plugin-sdk` — `react` is not resolvable
// from this package, and the over-the-wire manifest is JSON, so the component
// binding deliberately does not belong here.

/** What a visualizer claims to handle. */
export interface VisualizerContributes {
  /** Fenced code langs it renders, e.g. `['mermaid']` for ```mermaid blocks. */
  fences?: string[];
  /** File extensions that enable a preview, e.g. `['.csv']`. Leading dot optional. */
  fileExtensions?: string[];
  /**
   * Declares the visualizer reads the file as raw **bytes**, not UTF-8 text
   * (images, Parquet, Arrow, …). For a binary visualizer the host skips the
   * text fetch — which would corrupt binary data — and instead passes a `src`
   * URL to the raw bytes (see `VisualizerProps.src`). Only meaningful alongside
   * `fileExtensions`; fenced blocks are always text. Defaults to `false`.
   */
  binary?: boolean;
}

/** The serializable identity + capabilities of a visualizer plugin. */
export interface VisualizerManifest {
  /** Stable plugin id, e.g. `@funny/visualizer-mermaid`. */
  id: string;
  version: string;
  contributes: VisualizerContributes;
}

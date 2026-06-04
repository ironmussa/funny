import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactJsxRuntime from 'react/jsx-runtime';

import { hostApi } from './host-api';

/**
 * Install the host runtime globals that the `/vendor/*.mjs` import-map shims
 * re-export from. MUST run before any visualizer plugin is dynamically imported
 * (see `visualizer-loader.ts`), so that a plugin's bare `import React from
 * 'react'` / `import { useFunnyTheme } from '@funny/host'` resolves to the
 * host's own instances — the whole point of the full-trust, shared-React model.
 *
 * Idempotent: safe to call more than once.
 */
export function installVisualizerHostGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.__FUNNY_REACT__ = React;
  g.__FUNNY_REACT_DOM__ = ReactDOM;
  g.__FUNNY_REACT_JSX_RUNTIME__ = ReactJsxRuntime;
  g.__FUNNY_HOST__ = hostApi;
}

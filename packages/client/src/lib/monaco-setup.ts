// Wires Monaco to use locally-bundled ESM + Web Workers instead of the CDN
// AMD loader, which calls `new Function(...)` and trips the strict CSP
// (`script-src 'self'` with no `'unsafe-eval'`). Importing this module for its
// side effects MUST happen before any `<Editor />` from `@monaco-editor/react`
// mounts.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Vite's `?worker` query rewrites these imports to default-exporting worker
// constructors at build time. eslint-plugin-import's resolver can't see through
// the query string, so disable `import/default` for this block only.
/* eslint-disable import/default */
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
/* eslint-enable import/default */

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { VISUALIZER_IMPORT_MAP_JSON } from '@funny/shared/visualizer-importmap';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { getBuildInfo } from '../../scripts/build-info';

/**
 * Inject the visualizer import map into index.html so dynamically-loaded
 * visualizer plugins resolve `react` / `@funny/plugin-sdk` to the host's instances.
 * The inner text must be byte-identical to what the server hashes for CSP
 * (`script-src 'sha256-…'`), so both use `VISUALIZER_IMPORT_MAP_JSON` verbatim.
 */
function visualizerImportMap(): Plugin {
  return {
    name: 'funny-visualizer-importmap',
    transformIndexHtml(html) {
      const tag = `<script type="importmap">${VISUALIZER_IMPORT_MAP_JSON}</script>`;
      return html.replace('</head>', `    ${tag}\n  </head>`);
    },
  };
}

type ViteEnv = Record<string, string>;
type HttpsCert = { cert: Buffer; key: Buffer };

// VITE_HTTPS=true serves the dev client over HTTPS, which Vite serves as
// HTTP/2. Over plain HTTP the browser caps each origin at 6 connections, so a
// few slow git requests can queue every other API call behind them. Point
// VITE_HTTPS_CERT / VITE_HTTPS_KEY at a trusted cert (e.g. from mkcert);
// without them a self-signed cert is generated, which the browser warns
// about and which blocks the push-notification service worker.
function isHttpsEnabled(env: ViteEnv): boolean {
  return env.VITE_HTTPS === 'true' || env.VITE_HTTPS === '1';
}

/** The configured cert/key pair, or undefined when HTTPS is off or no pair is set. */
function resolveHttpsCert(env: ViteEnv): HttpsCert | undefined {
  if (!isHttpsEnabled(env) || !env.VITE_HTTPS_CERT || !env.VITE_HTTPS_KEY) return undefined;
  return { cert: readFileSync(env.VITE_HTTPS_CERT), key: readFileSync(env.VITE_HTTPS_KEY) };
}

/** HTTPS without a configured pair falls back to a generated self-signed cert. */
function httpsPlugins(httpsEnabled: boolean, httpsCert: HttpsCert | undefined): Plugin[] {
  return httpsEnabled && !httpsCert ? [basicSsl()] : [];
}

function httpsServerOptions(httpsCert: HttpsCert | undefined): { https?: HttpsCert } {
  return httpsCert ? { https: httpsCert } : {};
}

function forwardedProto(httpsEnabled: boolean): 'https' | 'http' {
  return httpsEnabled ? 'https' : 'http';
}

export default defineConfig(({ mode }) => {
  // Load env from both the monorepo root and the package dir (package-level overrides root)
  const monorepoRoot = resolve(__dirname, '../..');
  const env = { ...loadEnv(mode, monorepoRoot, ''), ...loadEnv(mode, process.cwd(), '') };
  const clientPort = Number(env.VITE_PORT) || 5173;
  const serverPort = Number(env.VITE_SERVER_PORT) || 3001;
  const serverTarget = `http://127.0.0.1:${serverPort}`;
  const benchmarkTarget = process.env.VITE_BENCHMARK_TARGET;
  const benchmarkInput =
    benchmarkTarget === 'markdown'
      ? { 'markdown-wasm': resolve(__dirname, 'benchmark/markdown-wasm.html') }
      : benchmarkTarget === 'thread'
        ? { 'thread-viewer': resolve(__dirname, 'benchmark/thread-viewer.html') }
        : process.env.VITE_BENCHMARK === '1'
          ? {
              'markdown-wasm': resolve(__dirname, 'benchmark/markdown-wasm.html'),
              'thread-viewer': resolve(__dirname, 'benchmark/thread-viewer.html'),
            }
          : undefined;

  // Default: listen on all interfaces (0.0.0.0) so http://<LAN-IP>:5173 works, matching a typical
  // API on HOST=0.0.0.0. If Vite only bound 127.0.0.1, the UI was unreachable except via localhost.
  // Set VITE_HOST=localhost in .env to restrict to loopback only.
  const viteHost =
    env.VITE_HOST === 'localhost' || env.VITE_HOST === '127.0.0.1'
      ? env.VITE_HOST
      : env.VITE_HOST === '0.0.0.0' || env.VITE_HOST === 'true'
        ? true
        : env.VITE_HOST
          ? env.VITE_HOST
          : true;

  const httpsEnabled = isHttpsEnabled(env);
  const httpsCert = resolveHttpsCert(env);

  return {
    envDir: monorepoRoot,
    // Inject the git-derived build identity as a compile-time constant so the
    // built bundle carries the build number two users can compare. See
    // scripts/build-info.ts and the __BUILD_INFO__ declaration in vite-env.d.ts.
    define: {
      __BUILD_INFO__: JSON.stringify(getBuildInfo()),
    },
    plugins: [
      react({ compiler: true }),
      visualizerImportMap(),
      ...httpsPlugins(httpsEnabled, httpsCert),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@funny/client-core/stores/circuit-breaker': resolve(
          __dirname,
          '../client-core/src/stores/circuit-breaker.ts',
        ),
        '@funny/client-core/stores/preferences': resolve(
          __dirname,
          '../client-core/src/stores/preferences.ts',
        ),
        '@funny/client-core/stores/thread-read': resolve(
          __dirname,
          '../client-core/src/stores/thread-read.ts',
        ),
        '@funny/client-core': resolve(__dirname, '../client-core/src/index.ts'),
        // Sätteri's browser entry lives at the workspace root but its WASI
        // binding is deliberately installed in this browser-only workspace.
        // Explicitly anchor the bare binding import here; otherwise Vite starts
        // resolution from Sätteri's root-level package directory and misses it.
        '@bruits/satteri-wasm32-wasi': resolve(
          __dirname,
          './node_modules/@bruits/satteri-wasm32-wasi',
        ),
      },
    },
    build: {
      rollupOptions: {
        ...(benchmarkInput ? { input: benchmarkInput } : {}),
        output: {
          manualChunks(id: string) {
            if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown';
            if (id.includes('/motion/')) return 'motion';
            // Only the highlight.js core: each language stays its own lazy chunk,
            // loaded by use-highlight.ts when a code block needs it. (The import
            // condition resolves `lib/languages/*` to `es/languages/*`.)
            if (
              id.includes('/highlight.js/') &&
              !/\/highlight\.js\/(?:es|lib)\/languages\//.test(id)
            )
              return 'syntax';
            if (id.includes('@monaco-editor/react')) return 'monaco';
            if (id.includes('/beautiful-mermaid/')) return 'mermaid';
            if (id.includes('@tiptap/react') || id.includes('@tiptap/core')) return 'tiptap';
            if (id.includes('lucide-react')) return 'icons';
          },
        },
      },
    },
    optimizeDeps: {
      // Abbacchio is now a published dependency. Prebundle both entry points
      // instead of serving its dist files with references to unpublished sources.
      include: [
        'decimal.js-light',
        'socket.io-client',
        'lucide-react',
        '@abbacchio/browser-transport',
        '@abbacchio/browser-transport/react',
      ],
    },
    server: {
      host: viteHost,
      ...httpsServerOptions(httpsCert),
      port: clientPort,
      allowedHosts: true,
      proxy: {
        // All API requests go to the server (which handles auth and proxies to runners)
        '/api': {
          target: serverTarget,
          changeOrigin: true,
          timeout: 60_000,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq, req) => {
              const host = req.headers.host;
              if (host) {
                proxyReq.setHeader('X-Forwarded-Host', host);
                proxyReq.setHeader('X-Forwarded-Proto', forwardedProto(httpsEnabled));
              }
            });
          },
        },
        // Socket.IO requests (polling + WebSocket upgrade)
        '/socket.io': {
          target: serverTarget,
          ws: true,
          changeOrigin: true,
        },
        // Installed visualizer extension bundles are served by the funny server
        // (from ~/.funny/extensions), not by Vite. In dev the app loads from
        // Vite (5173), so the browser's dynamic `import('/extensions/.../index.mjs')`
        // must be proxied to the server (3001) or it 404s against Vite.
        // (In prod a single server serves both the client and /extensions.)
        '/extensions': {
          target: serverTarget,
          changeOrigin: true,
        },
      },
    },
  };
});

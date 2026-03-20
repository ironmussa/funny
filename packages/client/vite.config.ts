import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env from both the monorepo root and the package dir (package-level overrides root)
  const monorepoRoot = resolve(__dirname, '../..');
  const env = { ...loadEnv(mode, monorepoRoot, ''), ...loadEnv(mode, process.cwd(), '') };
  const clientPort = Number(env.VITE_PORT) || 5173;
  const serverPort = Number(env.VITE_SERVER_PORT) || 3001;
  const serverTarget = `http://127.0.0.1:${serverPort}`;

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

  return {
    envDir: monorepoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown';
            if (id.includes('/motion/')) return 'motion';
            if (id.includes('/shiki/')) return 'syntax';
            if (id.includes('@monaco-editor/react')) return 'monaco';
            if (id.includes('/mermaid/')) return 'mermaid';
            if (id.includes('@tiptap/react') || id.includes('@tiptap/core')) return 'tiptap';
          },
        },
      },
    },
    optimizeDeps: {
      include: ['decimal.js-light', 'socket.io-client'],
    },
    server: {
      host: viteHost,
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
                proxyReq.setHeader('X-Forwarded-Proto', 'http');
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
      },
    },
  };
});

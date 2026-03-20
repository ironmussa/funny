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
      include: ['decimal.js-light'],
    },
    server: {
      host: env.VITE_HOST || 'localhost',
      port: clientPort,
      allowedHosts: true,
      proxy: {
        // All API requests go to the server (which handles auth and proxies to runners)
        '/api': {
          target: serverTarget,
          changeOrigin: true,
          timeout: 60_000,
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

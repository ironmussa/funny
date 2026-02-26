import { resolve } from 'path';

import react from '@vitejs/plugin-react';
/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const clientPort = Number(env.VITE_PORT) || 5173;
  const serverPort = Number(env.VITE_SERVER_PORT) || 3001;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/setup.ts'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            markdown: ['react-markdown', 'remark-gfm'],
            motion: ['motion'],
            syntax: ['shiki'],
            monaco: ['@monaco-editor/react'],
            mermaid: ['mermaid'],
          },
        },
      },
    },
    server: {
      host: env.VITE_HOST || '127.0.0.1',
      port: clientPort,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
          // Timeout stale connections after 60s — must be generous enough for
          // slow git operations (commit with pre-commit hooks, push, PR creation).
          // Previously 10s which caused "Failed to fetch" on commits with hooks.
          timeout: 60_000,
        },
        '/ws': {
          target: `ws://localhost:${serverPort}`,
          ws: true,
        },
      },
    },
  };
});

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
  const wsTarget = `ws://127.0.0.1:${serverPort}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
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
            tiptap: ['@tiptap/react', '@tiptap/core'],
          },
        },
      },
    },
    server: {
      host: env.VITE_HOST || 'localhost',
      port: clientPort,
      allowedHosts: true,
      proxy: {
        // All API requests go to the server (which handles auth and proxies/mounts runtime)
        '/api': {
          target: serverTarget,
          changeOrigin: true,
          timeout: 60_000,
        },
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});

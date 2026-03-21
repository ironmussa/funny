import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const WORKSPACE_PKG = path.resolve(__dirname, '..', '..', 'runtime');

/**
 * Vite plugin that adds a POST /api/convert endpoint.
 * Accepts a .ts evflow model file content, writes it as a temp file inside
 * packages/runtime (so workspace imports like @funny/evflow resolve),
 * uses Vite's ssrLoadModule to import it in-memory, finds the EventModel
 * export, and returns JSON. No subprocess needed.
 */
function evflowConvertPlugin(): Plugin {
  return {
    name: 'evflow-convert',
    configureServer(server) {
      server.middlewares.use('/api/convert', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const body = Buffer.concat(chunks).toString('utf-8');

          // Write inside a workspace package so @funny/* imports resolve
          const tmpPath = path.join(WORKSPACE_PKG, '.evflow-tmp-model.ts');
          writeFileSync(tmpPath, body);

          try {
            // Use Vite's SSR module loader — handles TS transpilation
            // and workspace resolution in-memory
            const mod = await server.ssrLoadModule(tmpPath);

            let model = null;

            // 1. Default export is an EventModel
            if (mod.default?.toJSON) {
              model = mod.default;
            }

            // 2. Named export function that returns an EventModel
            if (!model) {
              for (const val of Object.values(mod)) {
                if (typeof val === 'function') {
                  try {
                    const result = (val as Function)();
                    if (result?.toJSON) {
                      model = result;
                      break;
                    }
                  } catch {}
                }
              }
            }

            // 3. Named export that IS an EventModel instance
            if (!model) {
              for (const val of Object.values(mod)) {
                if (val && typeof val === 'object' && typeof (val as any).toJSON === 'function') {
                  model = val;
                  break;
                }
              }
            }

            if (!model) {
              throw new Error(
                'No EventModel found. The file should export a function returning an EventModel or an EventModel instance.',
              );
            }

            res.setHeader('Content-Type', 'application/json');
            res.end((model as any).toJSON());
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Conversion failed' }));
          } finally {
            // Invalidate the module from Vite's cache so re-uploads work
            const modNode = server.moduleGraph.getModuleById(tmpPath);
            if (modNode) server.moduleGraph.invalidateModule(modNode);
            try {
              unlinkSync(tmpPath);
            } catch {}
          }
        });
      });
    },
  };
}

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Vite plugin that adds a GET /api/source endpoint.
 * Reads a source file from the workspace and returns its content.
 * Only active in dev mode.
 */
function evflowSourcePlugin(): Plugin {
  return {
    name: 'evflow-source',
    configureServer(server) {
      server.middlewares.use('/api/source', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        const url = new URL(req.url!, `http://${req.headers.host}`);
        const filePath = url.searchParams.get('file');

        if (!filePath) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing ?file= parameter' }));
          return;
        }

        const resolvedPath = path.resolve(WORKSPACE_ROOT, filePath);

        // Prevent path traversal outside workspace
        if (!resolvedPath.startsWith(WORKSPACE_ROOT)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Path outside workspace' }));
          return;
        }

        try {
          const content = readFileSync(resolvedPath, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ content, file: filePath }));
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `File not found: ${filePath}` }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), evflowConvertPlugin(), evflowSourcePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

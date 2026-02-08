import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { autoMigrate } from './db/migrate.js';
import { projectRoutes } from './routes/projects.js';
import { threadRoutes } from './routes/threads.js';
import { gitRoutes } from './routes/git.js';
import browseRoutes from './routes/browse.js';
import mcpRoutes from './routes/mcp.js';
import skillsRoutes from './routes/skills.js';
import { wsBroker } from './services/ws-broker.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'tauri://localhost',
      'https://tauri.localhost',
    ],
  })
);

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount routes
app.route('/api/projects', projectRoutes);
app.route('/api/threads', threadRoutes);
app.route('/api/git', gitRoutes);
app.route('/api/browse', browseRoutes);
app.route('/api/mcp', mcpRoutes);
app.route('/api/skills', skillsRoutes);

const port = Number(process.env.PORT) || 3001;

// Auto-create tables on startup, then start server
autoMigrate();
console.log(`[server] Starting on http://localhost:${port}`);

export default {
  port,
  fetch(req: Request, server: any) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    // All other requests handled by Hono
    return app.fetch(req);
  },
  websocket: {
    open(ws: any) {
      wsBroker.addClient(ws);
    },
    close(ws: any) {
      wsBroker.removeClient(ws);
    },
    message(_ws: any, _msg: any) {
      // No client→server messages needed for now
    },
  },
};

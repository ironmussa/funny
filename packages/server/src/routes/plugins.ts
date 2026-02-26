import { Hono } from 'hono';

import { listPlugins } from '../services/plugin-service.js';

const app = new Hono();

// List installed plugins (read-only)
app.get('/', (c) => {
  const plugins = listPlugins();
  return c.json({ plugins });
});

export default app;

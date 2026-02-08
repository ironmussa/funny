import { Hono } from 'hono';
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  RECOMMENDED_SERVERS,
} from '../services/mcp-service.js';
import type { McpAddRequest, McpRemoveRequest } from '@a-parallel/shared';

const app = new Hono();

// List MCP servers for a project
app.get('/servers', async (c) => {
  const projectPath = c.req.query('projectPath');
  if (!projectPath) {
    return c.json({ error: 'projectPath query parameter required' }, 400);
  }

  try {
    const servers = await listMcpServers(projectPath);
    return c.json({ servers });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Add an MCP server
app.post('/servers', async (c) => {
  const body = await c.req.json<McpAddRequest>();

  if (!body.name || !body.type || !body.projectPath) {
    return c.json({ error: 'name, type, and projectPath are required' }, 400);
  }

  try {
    await addMcpServer(body);
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Remove an MCP server
app.delete('/servers/:name', async (c) => {
  const name = c.req.param('name');
  const projectPath = c.req.query('projectPath');
  const scope = c.req.query('scope') as 'project' | 'user' | undefined;

  if (!projectPath) {
    return c.json({ error: 'projectPath query parameter required' }, 400);
  }

  try {
    await removeMcpServer({ name, projectPath, scope });
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get recommended MCP servers
app.get('/recommended', (c) => {
  return c.json({ servers: RECOMMENDED_SERVERS });
});

export default app;

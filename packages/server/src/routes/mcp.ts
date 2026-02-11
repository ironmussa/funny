import { Hono } from 'hono';
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  RECOMMENDED_SERVERS,
} from '../services/mcp-service.js';
import { startOAuthFlow, handleOAuthCallback } from '../services/mcp-oauth.js';
import { addMcpServerSchema, validate } from '../validation/schemas.js';
import { BadRequest } from '../middleware/error-handler.js';

const app = new Hono();

// List MCP servers for a project
app.get('/servers', async (c) => {
  const projectPath = c.req.query('projectPath');
  if (!projectPath) throw BadRequest('projectPath query parameter required');

  const servers = await listMcpServers(projectPath);
  return c.json({ servers });
});

// Add an MCP server
app.post('/servers', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(addMcpServerSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  await addMcpServer(parsed.data);
  return c.json({ ok: true });
});

// Remove an MCP server
app.delete('/servers/:name', async (c) => {
  const name = c.req.param('name');
  const projectPath = c.req.query('projectPath');
  const scope = c.req.query('scope') as 'project' | 'user' | undefined;

  if (!projectPath) throw BadRequest('projectPath query parameter required');

  await removeMcpServer({ name, projectPath, scope });
  return c.json({ ok: true });
});

// Get recommended MCP servers
app.get('/recommended', (c) => {
  return c.json({ servers: RECOMMENDED_SERVERS });
});

// Start OAuth flow for an MCP server
app.post('/oauth/start', async (c) => {
  const body = await c.req.json();
  const { serverName, projectPath } = body;

  if (!serverName || !projectPath) {
    throw BadRequest('serverName and projectPath are required');
  }

  const servers = await listMcpServers(projectPath);
  const server = servers.find((s) => s.name === serverName);
  if (!server) throw BadRequest(`Server "${serverName}" not found`);
  if (!server.url) throw BadRequest(`Server "${serverName}" has no URL (only HTTP servers support OAuth)`);

  const url = new URL(c.req.url);
  const callbackBaseUrl = `${url.protocol}//${url.host}`;

  const { authUrl } = await startOAuthFlow(serverName, server.url, projectPath, callbackBaseUrl);
  return c.json({ authUrl });
});

// OAuth callback (called by external OAuth provider redirect — exempt from bearer auth)
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    const errorDesc = c.req.query('error_description') || error;
    return c.html(renderCallbackPage(false, errorDesc));
  }

  if (!code || !state) {
    return c.html(renderCallbackPage(false, 'Missing code or state parameter'));
  }

  const result = await handleOAuthCallback(code, state);
  return c.html(renderCallbackPage(result.success, result.error));
});

function renderCallbackPage(success: boolean, error?: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>MCP Authentication</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa}p{text-align:center;font-size:14px}</style>
</head>
<body>
  <p>${success ? 'Authentication successful! This window will close.' : `Authentication failed: ${error || 'Unknown error'}`}</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'mcp-oauth-callback',
        success: ${success},
        error: ${error ? JSON.stringify(error) : 'null'}
      }, '*');
    }
    setTimeout(() => window.close(), ${success ? 1500 : 5000});
  </script>
</body>
</html>`;
}

export default app;

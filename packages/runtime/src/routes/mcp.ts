/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: McpService
 */

import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { startOAuthFlow, handleOAuthCallback } from '../services/mcp-oauth.js';
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  toggleMcpServer,
  RECOMMENDED_SERVERS,
} from '../services/mcp-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { requireProjectPath } from '../utils/path-scope.js';
import { resultToResponse } from '../utils/result-response.js';
import { addMcpServerSchema, validate } from '../validation/schemas.js';

const app = new Hono<HonoEnv>();

// List MCP servers for a project
app.get('/servers', async (c) => {
  const projectPath = c.req.query('projectPath');
  if (!projectPath)
    return resultToResponse(c, err(badRequest('projectPath query parameter required')));

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const result = await listMcpServers(projectPath);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ servers: result.value });
});

// Add an MCP server
app.post('/servers', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(addMcpServerSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const denied = await requireProjectPath(parsed.value.projectPath, c.get('userId'));
  if (denied) return denied;

  const result = await addMcpServer(parsed.value);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Remove an MCP server
app.delete('/servers/:name', async (c) => {
  const name = c.req.param('name');
  const projectPath = c.req.query('projectPath');
  const scope = c.req.query('scope') as 'project' | 'user' | undefined;

  if (!projectPath)
    return resultToResponse(c, err(badRequest('projectPath query parameter required')));

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const result = await removeMcpServer({ name, projectPath, scope });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Toggle MCP server enabled/disabled
app.patch('/servers/:name/toggle', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json();
  const { projectPath, disabled } = body;

  if (!projectPath || typeof disabled !== 'boolean')
    return resultToResponse(c, err(badRequest('projectPath and disabled (boolean) are required')));

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const result = await toggleMcpServer({ name, projectPath, disabled });
  if (result.isErr()) return resultToResponse(c, result);
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
    return resultToResponse(c, err(badRequest('serverName and projectPath are required')));
  }

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const serversResult = await listMcpServers(projectPath);
  if (serversResult.isErr()) return resultToResponse(c, serversResult);
  const servers = serversResult.value;

  const server = servers.find((s) => s.name === serverName);
  if (!server) return resultToResponse(c, err(badRequest(`Server "${serverName}" not found`)));
  if (!server.url)
    return resultToResponse(
      c,
      err(badRequest(`Server "${serverName}" has no URL (only HTTP servers support OAuth)`)),
    );

  // Use forwarded headers to reconstruct the public-facing origin.
  // When requests arrive via the WS tunnel, c.req.url is http://localhost (no port).
  const fwdHost = c.req.header('X-Forwarded-Host');
  const fwdProto = c.req.header('X-Forwarded-Proto');
  const callbackBaseUrl = fwdHost
    ? `${fwdProto || 'http'}://${fwdHost}`
    : (() => {
        const u = new URL(c.req.url);
        return `${u.protocol}//${u.host}`;
      })();

  const oauthResult = await startOAuthFlow(serverName, server.url, projectPath, callbackBaseUrl);
  if (oauthResult.isErr()) return resultToResponse(c, oauthResult);
  return c.json({ authUrl: oauthResult.value.authUrl });
});

// Set a manual bearer token for an MCP server
app.post('/oauth/token', async (c) => {
  const body = await c.req.json();
  const { serverName, projectPath, token } = body;

  if (!serverName || !projectPath || !token) {
    return resultToResponse(c, err(badRequest('serverName, projectPath, and token are required')));
  }

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const serversResult = await listMcpServers(projectPath);
  if (serversResult.isErr()) return resultToResponse(c, serversResult);
  const servers = serversResult.value;

  const server = servers.find((s) => s.name === serverName);
  if (!server) return resultToResponse(c, err(badRequest(`Server "${serverName}" not found`)));
  if (!server.url) return resultToResponse(c, err(badRequest(`Server "${serverName}" has no URL`)));

  // Remove and re-add with Authorization header (best-effort remove)
  await removeMcpServer({ name: serverName, projectPath });

  const addResult = await addMcpServer({
    name: serverName,
    type: 'http',
    url: server.url,
    headers: { Authorization: `Bearer ${token}` },
    projectPath,
  });
  if (addResult.isErr()) return resultToResponse(c, addResult);

  return c.json({ ok: true });
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

/** Escape HTML special characters to prevent XSS */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCallbackPage(success: boolean, error?: string): string {
  const safeError = error ? escapeHtml(error) : 'Unknown error';
  return `<!DOCTYPE html>
<html>
<head><title>MCP Authentication</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa}p{text-align:center;font-size:14px}</style>
</head>
<body>
  <p>${success ? 'Authentication successful! This window will close.' : `Authentication failed: ${safeError}`}</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'mcp-oauth-callback',
        success: ${success},
        error: ${error ? JSON.stringify(error) : 'null'}
      }, window.location.origin);
    }
    setTimeout(() => window.close(), ${success ? 1500 : 5000});
  </script>
</body>
</html>`;
}

export default app;

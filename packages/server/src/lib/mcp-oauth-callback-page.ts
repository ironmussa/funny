/**
 * The MCP OAuth callback page, rendered by the SERVER (H3).
 *
 * The callback is served on the server's origin to an unauthenticated browser,
 * so its HTML and script must never come from a runner: a runner-supplied page
 * would run same-origin with every user's session. The proxy asks the bound
 * runner for a JSON `{ success, error }` result and renders this page itself;
 * the script is a static server asset (`/api/mcp/oauth/callback.js`).
 *
 * The page has no inline script (CSP `script-src 'self'`): status reaches the
 * script through escaped `data-*` attributes on the status element.
 */

/** CSP applied to the callback page and its script (see server index.ts). */
export const MCP_OAUTH_CALLBACK_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Same-origin script loaded by the callback page; posts the status to the opener. */
export const MCP_OAUTH_CALLBACK_SCRIPT = `(() => {
  try {
    const el = document.getElementById('mcp-oauth-status');
    if (!el) return;
    const success = el.dataset.success === 'true';
    const error = el.dataset.error || null;
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-callback', success, error }, window.location.origin);
    }
    setTimeout(() => window.close(), success ? 1500 : 5000);
  } catch (_) {
    /* swallow — the user already sees a status message */
  }
})();`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMcpOAuthCallbackPage(success: boolean, error?: string | null): string {
  const message = success
    ? 'Authentication successful! This window will close.'
    : `Authentication failed: ${escapeHtml(error || 'Unknown error')}`;
  return `<!DOCTYPE html>
<html>
<head><title>MCP Authentication</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa}p{text-align:center;font-size:14px}</style>
</head>
<body>
  <p id="mcp-oauth-status" data-success="${success}" data-error="${escapeHtml(success ? '' : error || '')}">${message}</p>
  <script src="/api/mcp/oauth/callback.js"></script>
</body>
</html>`;
}

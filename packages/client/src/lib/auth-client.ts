import { usernameClient, adminClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// In a normal browser AND during `tauri:dev` (webview loads the Vite dev server
// over http://) we can stay relative — Vite proxies /api to the server.
// Only the packaged Tauri binary loads from a non-http origin (tauri://localhost
// or http://tauri.localhost), where an absolute URL to the sidecar is required.
const isPackagedTauri =
  typeof window !== 'undefined' &&
  !!(window as any).__TAURI_INTERNALS__ &&
  window.location.protocol !== 'http:' &&
  window.location.protocol !== 'https:';
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const baseURL = isPackagedTauri ? `http://localhost:${serverPort}` : '';

export const authClient = createAuthClient({
  baseURL,
  basePath: '/api/auth',
  plugins: [usernameClient(), adminClient(), organizationClient()],
});

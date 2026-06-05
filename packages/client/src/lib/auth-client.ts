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

const authClientOptions = {
  baseURL,
  basePath: '/api/auth',
  plugins: [usernameClient(), adminClient(), organizationClient()],
};

// Explicit annotation: bun's isolated install places zod at a non-portable
// `.bun/zod@x/...` path, so tsc cannot name better-auth's zod-backed inferred
// client type during the build (TS2742). Naming it through the local options
// const keeps the type portable without dropping any plugin methods.
export const authClient: ReturnType<typeof createAuthClient<typeof authClientOptions>> =
  createAuthClient(authClientOptions);

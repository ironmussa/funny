import { usernameClient, adminClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const baseURL = isTauri ? `http://localhost:${serverPort}` : '';

export const authClient = createAuthClient({
  baseURL,
  basePath: '/api/auth',
  plugins: [usernameClient(), adminClient()],
});

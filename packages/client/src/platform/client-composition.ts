import { validateClientPlatform, type ClientPlatform } from '@funny/client-core';
import { toast } from 'sonner';

import { createWebPlatform } from './web/create-web-platform';
import { createRequestLifetime } from './web/request-lifetime';

export interface ClientComposition {
  platform: ClientPlatform;
}

export function createClientComposition(platform: ClientPlatform): ClientComposition {
  validateClientPlatform(platform);
  return { platform };
}

const showToast = (
  level: 'info' | 'success' | 'warning' | 'error',
  message: string,
  description?: string,
): void => {
  if (description) toast[level](message, { description });
  else toast[level](message);
};

const requestLifetime = createRequestLifetime(window);
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', requestLifetime.abort);
  import.meta.hot.dispose(() => {
    import.meta.hot?.off('vite:beforeFullReload', requestLifetime.abort);
    requestLifetime.dispose();
  });
}

export const clientComposition = createClientComposition(
  createWebPlatform({
    window,
    document,
    fetch: window.fetch.bind(window),
    serverPort: import.meta.env.VITE_SERVER_PORT,
    allowedContainerOrigins: import.meta.env.VITE_ALLOWED_CONTAINER_ORIGINS,
    showToast,
    requestLifetimeSignal: requestLifetime.signal,
  }),
);

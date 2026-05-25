/**
 * Routes inbound browser-session WS events (frame / ready / result / console /
 * error / closed) to the panel store and the frame ingester. Kept in its own
 * file so the global `ws-event-dispatch.ts` doesn't carry these imports.
 */

import { resolveBrowserSessionRequest } from '@/lib/browser-session-client';
import { ingestBrowserSessionFrame } from '@/lib/browser-session-frames';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('browser-session');

export function dispatchBrowserSessionEvent(type: string, data: unknown): boolean {
  switch (type) {
    case 'browser-session:frame': {
      const d = data as { sessionId: string; data: string };
      ingestBrowserSessionFrame(d.sessionId, d.data);
      return true;
    }

    case 'browser-session:ready': {
      const d = data as { sessionId: string; url: string };
      import('@/stores/browser-panel-store').then(({ useBrowserPanelStore }) => {
        const store = useBrowserPanelStore.getState();
        if (store.sessionId === d.sessionId) {
          store.setSessionStatus('ready', null);
        }
      });
      return true;
    }

    case 'browser-session:result': {
      const d = data as { requestId: string; ok: boolean; value?: unknown; error?: string };
      resolveBrowserSessionRequest(d.requestId, d.ok, d.value, d.error);
      return true;
    }

    case 'browser-session:console': {
      // Visible only at debug log level — runner already emits the original.
      log.debug('console', data as Record<string, unknown>);
      return true;
    }

    case 'browser-session:error': {
      const d = data as { sessionId: string; message: string };
      log.warn('page error', d);
      return true;
    }

    case 'browser-session:closed': {
      const d = data as { sessionId: string; reason: string; message?: string };
      log.info('session closed', d);
      import('@/stores/browser-panel-store').then(({ useBrowserPanelStore }) => {
        const store = useBrowserPanelStore.getState();
        if (store.sessionId === d.sessionId) {
          const status = d.reason === 'too_many_sessions' ? 'too-many-sessions' : 'disconnected';
          store.setSessionStatus(status, d.message ?? null);
        }
      });
      return true;
    }

    default:
      return false;
  }
}

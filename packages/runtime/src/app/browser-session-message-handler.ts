import type {
  WSBrowserSessionCloseData,
  WSBrowserSessionExecuteData,
  WSBrowserSessionHeartbeatData,
  WSBrowserSessionInputData,
  WSBrowserSessionInspectAtData,
  WSBrowserSessionInspectRectData,
  WSBrowserSessionNavData,
  WSBrowserSessionNavigateData,
  WSBrowserSessionOpenData,
  WSBrowserSessionScreenshotData,
} from '@funny/shared';

import { log } from '../lib/logger.js';
import { browserSessionManager } from '../services/browser-session-manager.js';

const NS = 'browser-session';

/**
 * Dispatches inbound WS messages typed `browser-session:*` to the manager.
 * Mirrors the shape of `handlePtyMessage` — call from the central WS handler
 * once we identify a browser-session prefix.
 */
export function handleBrowserSessionMessage(type: string, data: unknown, userId: string): boolean {
  log.info('WS message received', { namespace: NS, type, userId });
  switch (type) {
    case 'browser-session:open': {
      const d = data as WSBrowserSessionOpenData;
      log.info('handling open', { namespace: NS, sessionId: d.sessionId, url: d.url });
      browserSessionManager.open(userId, d.sessionId, d.url).catch((err) => {
        log.error('open failed', { namespace: NS, sessionId: d.sessionId, error: String(err) });
      });
      return true;
    }

    case 'browser-session:navigate': {
      const d = data as WSBrowserSessionNavigateData;
      browserSessionManager.navigate(d.sessionId, d.url).catch((err) => {
        log.warn('navigate failed', {
          namespace: NS,
          sessionId: d.sessionId,
          error: String(err),
        });
      });
      return true;
    }

    case 'browser-session:nav': {
      const d = data as WSBrowserSessionNavData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.nav(d.sessionId, d.action),
        )
        .catch((err) => {
          log.warn('nav failed', {
            namespace: NS,
            sessionId: d.sessionId,
            action: d.action,
            error: String(err),
          });
        });
      return true;
    }

    case 'browser-session:input': {
      const d = data as WSBrowserSessionInputData;
      browserSessionManager.dispatchInput(d.sessionId, d).catch(() => {
        /* swallow — input is best-effort, frame stream provides visual feedback */
      });
      return true;
    }

    case 'browser-session:inspect-at': {
      const d = data as WSBrowserSessionInspectAtData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.inspectAt(d.sessionId, d.x, d.y),
        )
        .catch((err) => {
          log.warn('inspect-at failed', {
            namespace: NS,
            sessionId: d.sessionId,
            error: String(err),
          });
        });
      return true;
    }

    case 'browser-session:inspect-rect': {
      const d = data as WSBrowserSessionInspectRectData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.inspectRect(d.sessionId, d.x, d.y, d.w, d.h),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:screenshot': {
      const d = data as WSBrowserSessionScreenshotData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.screenshot(d.sessionId),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:execute': {
      const d = data as WSBrowserSessionExecuteData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.execute(d.sessionId, d.expression),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:heartbeat': {
      const d = data as WSBrowserSessionHeartbeatData;
      browserSessionManager.heartbeat(d.sessionId);
      return true;
    }

    case 'browser-session:close': {
      const d = data as WSBrowserSessionCloseData;
      browserSessionManager.close(d.sessionId, 'user').catch(() => {});
      return true;
    }

    default:
      return false;
  }
}

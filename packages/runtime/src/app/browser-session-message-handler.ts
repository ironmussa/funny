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
      // SAFETY: `type === 'browser-session:open'` here, and the client sends WSBrowserSessionOpenData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionOpenData;
      log.info('handling open', { namespace: NS, sessionId: d.sessionId, url: d.url });
      browserSessionManager.open(userId, d.sessionId, d.url, { origin: 'panel' }).catch((err) => {
        log.error('open failed', { namespace: NS, sessionId: d.sessionId, error: String(err) });
      });
      return true;
    }

    case 'browser-session:navigate': {
      // SAFETY: `type === 'browser-session:navigate'` here, and the client sends WSBrowserSessionNavigateData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionNavigateData;
      browserSessionManager.navigate(userId, d.sessionId, d.url).catch((err) => {
        log.warn('navigate failed', {
          namespace: NS,
          sessionId: d.sessionId,
          error: String(err),
        });
      });
      return true;
    }

    case 'browser-session:nav': {
      // SAFETY: `type === 'browser-session:nav'` here, and the client sends WSBrowserSessionNavData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionNavData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.nav(userId, d.sessionId, d.action),
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
      // SAFETY: `type === 'browser-session:input'` here, and the client sends WSBrowserSessionInputData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionInputData;
      browserSessionManager.dispatchInput(userId, d.sessionId, d).catch(() => {
        /* swallow — input is best-effort, frame stream provides visual feedback */
      });
      return true;
    }

    case 'browser-session:inspect-at': {
      // SAFETY: `type === 'browser-session:inspect-at'` here, and the client sends WSBrowserSessionInspectAtData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionInspectAtData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.inspectAt(userId, d.sessionId, d.x, d.y),
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
      // SAFETY: `type === 'browser-session:inspect-rect'` here, and the client sends WSBrowserSessionInspectRectData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionInspectRectData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.inspectRect(userId, d.sessionId, d.x, d.y, d.w, d.h),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:screenshot': {
      // SAFETY: `type === 'browser-session:screenshot'` here, and the client sends WSBrowserSessionScreenshotData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionScreenshotData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.screenshot(userId, d.sessionId),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:execute': {
      // SAFETY: `type === 'browser-session:execute'` here, and the client sends WSBrowserSessionExecuteData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionExecuteData;
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.execute(userId, d.sessionId, d.expression),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:heartbeat': {
      // SAFETY: `type === 'browser-session:heartbeat'` here, and the client sends WSBrowserSessionHeartbeatData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionHeartbeatData;
      browserSessionManager.heartbeat(userId, d.sessionId);
      return true;
    }

    case 'browser-session:close': {
      // SAFETY: `type === 'browser-session:close'` here, and the client sends WSBrowserSessionCloseData for that message type (shared WS protocol).
      const d = data as WSBrowserSessionCloseData;
      browserSessionManager
        .closeFromClient(userId, d.sessionId, d.reason, d.closeId)
        .catch((err) => {
          log.warn('close failed', { namespace: NS, sessionId: d.sessionId, error: String(err) });
        });
      return true;
    }

    default:
      return false;
  }
}

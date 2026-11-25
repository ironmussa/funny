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

/** The payload of one `browser-session:*` command; its `type` says which one. */
export type BrowserSessionCommandData =
  | WSBrowserSessionOpenData
  | WSBrowserSessionNavigateData
  | WSBrowserSessionNavData
  | WSBrowserSessionInputData
  | WSBrowserSessionInspectAtData
  | WSBrowserSessionInspectRectData
  | WSBrowserSessionScreenshotData
  | WSBrowserSessionExecuteData
  | WSBrowserSessionHeartbeatData
  | WSBrowserSessionCloseData;

/**
 * The payload of the command `type` names. The command route only checks that
 * the payload is an object, so each command reads its own fields unchecked.
 */
function commandData<T extends BrowserSessionCommandData>(data: BrowserSessionCommandData): T {
  // SAFETY: callers pass `data` from the same frame as the `type` this
  // function's caller switched on; the client sends each `browser-session:*`
  // type with that command's payload. Fields are not validated here: a wrong
  // field reaches the browser session manager as `undefined`, as before.
  return data as T;
}

/**
 * Dispatches inbound WS messages typed `browser-session:*` to the manager.
 * Mirrors the shape of `handlePtyMessage` — call from the central WS handler
 * once we identify a browser-session prefix.
 */
export function handleBrowserSessionMessage(
  type: string,
  data: BrowserSessionCommandData,
  userId: string,
): boolean {
  log.info('WS message received', { namespace: NS, type, userId });
  switch (type) {
    case 'browser-session:open': {
      const d = commandData<WSBrowserSessionOpenData>(data);
      log.info('handling open', { namespace: NS, sessionId: d.sessionId, url: d.url });
      browserSessionManager.open(userId, d.sessionId, d.url, { origin: 'panel' }).catch((err) => {
        log.error('open failed', { namespace: NS, sessionId: d.sessionId, error: String(err) });
      });
      return true;
    }

    case 'browser-session:navigate': {
      const d = commandData<WSBrowserSessionNavigateData>(data);
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
      const d = commandData<WSBrowserSessionNavData>(data);
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
      const d = commandData<WSBrowserSessionInputData>(data);
      browserSessionManager.dispatchInput(userId, d.sessionId, d).catch(() => {
        /* swallow — input is best-effort, frame stream provides visual feedback */
      });
      return true;
    }

    case 'browser-session:inspect-at': {
      const d = commandData<WSBrowserSessionInspectAtData>(data);
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
      const d = commandData<WSBrowserSessionInspectRectData>(data);
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.inspectRect(userId, d.sessionId, d.x, d.y, d.w, d.h),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:screenshot': {
      const d = commandData<WSBrowserSessionScreenshotData>(data);
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.screenshot(userId, d.sessionId),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:execute': {
      const d = commandData<WSBrowserSessionExecuteData>(data);
      browserSessionManager
        .handleRequest(userId, d.sessionId, d.requestId, () =>
          browserSessionManager.execute(userId, d.sessionId, d.expression),
        )
        .catch(() => {});
      return true;
    }

    case 'browser-session:heartbeat': {
      const d = commandData<WSBrowserSessionHeartbeatData>(data);
      browserSessionManager.heartbeat(userId, d.sessionId);
      return true;
    }

    case 'browser-session:close': {
      const d = commandData<WSBrowserSessionCloseData>(data);
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

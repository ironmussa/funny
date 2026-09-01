import { create } from '@bufbuild/protobuf';
import { BROWSER_V1_CARRIER_EVENTS } from '@funny/shared/browser-protocol';
import { StatusCode, StatusSchema } from '@funny/shared/browser-v1/common';
import type { Socket } from 'socket.io';

import { encodeSocketIoStatus } from './browser-v1-wire.js';

export interface BrowserV1SessionGuard {
  checkNow(): Promise<boolean>;
  stop(): void;
}

export function setupBrowserV1SessionGuard(
  socket: Socket,
  principalUserId: string,
  options: {
    getSession(headers: Headers): Promise<{ user?: { id?: string } } | null>;
    intervalMs?: number;
  },
): BrowserV1SessionGuard {
  let stopped = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const checkNow = async (): Promise<boolean> => {
    if (stopped || checking) return !stopped;
    checking = true;
    try {
      const cookie = socket.handshake.headers.cookie;
      if (!cookie) {
        revoke();
        return false;
      }
      const headers = new Headers({ cookie });
      const session = await options.getSession(headers);
      if (session?.user?.id !== principalUserId) {
        revoke();
        return false;
      }
      return true;
    } catch {
      // A transient auth-store failure must not disclose or silently change identity.
      return true;
    } finally {
      checking = false;
    }
  };

  const revoke = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (socket.data.browserV1) {
      socket.emit(
        BROWSER_V1_CARRIER_EVENTS.control,
        encodeSocketIoStatus(
          create(StatusSchema, {
            code: StatusCode.REVOKED,
            message: 'Authenticated session is no longer active',
          }),
        ),
      );
    }
    socket.disconnect(true);
  };

  const intervalMs = Math.max(1_000, options.intervalMs ?? 30_000);
  timer = setInterval(() => void checkNow(), intervalMs);
  timer.unref?.();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
  };
  socket.on('disconnect', stop);
  return { checkNow, stop };
}

/**
 * Per-thread presence + live-stream subscription for thread-sharing.
 *
 * On `thread:open` the server validates view access, joins the viewer to the
 * thread's presence room (and, for sharees, the sharee-only stream room — the
 * owner already gets the stream via their `user:` room), and broadcasts
 * presence. Presence is awareness-shaped: each viewer is keyed by a
 * per-connection `clientId` (the socket id) → `{ user: { id, name, image } }`,
 * so it can later ride a Yjs awareness provider unchanged (design D8).
 */

import {
  PRESENCE_JOIN_EVENT,
  PRESENCE_LEAVE_EVENT,
  PRESENCE_SYNC_EVENT,
  THREAD_CLOSE_EVENT,
  THREAD_OPEN_EVENT,
  threadOpenSchema,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { isRateLimited } from '../socketio-rate-limit.js';
import { canUserViewThread, getUserDisplay, isThreadOwnedBy } from '../thread-access-check.js';
import { threadPresenceRoom, threadStreamRoom } from '../ws-relay.js';

interface Viewer {
  clientId: string;
  user: { id: string; name: string; image: string | null };
}

/** threadId → (socketId → Viewer). Module-level live presence roster. */
const presenceByThread = new Map<string, Map<string, Viewer>>();

function rosterFor(threadId: string): Viewer[] {
  return Array.from(presenceByThread.get(threadId)?.values() ?? []);
}

/** Test-only: clear the module-level presence roster between cases. */
export function __resetPresenceForTests(): void {
  presenceByThread.clear();
}

/** Remove a socket from a thread's roster + rooms and announce the departure. */
function leaveThread(socket: Socket, threadId: string): void {
  const roster = presenceByThread.get(threadId);
  if (!roster || !roster.has(socket.id)) return;
  roster.delete(socket.id);
  if (roster.size === 0) presenceByThread.delete(threadId);

  socket.leave(threadPresenceRoom(threadId));
  socket.leave(threadStreamRoom(threadId));
  socket
    .to(threadPresenceRoom(threadId))
    .emit(PRESENCE_LEAVE_EVENT, { threadId, clientId: socket.id });

  const open = socket.data.openThreads as Set<string> | undefined;
  open?.delete(threadId);
}

export function setupThreadPresenceHandlers(socket: Socket, userId: string): void {
  const openThreads: Set<string> = (socket.data.openThreads ??= new Set<string>());

  socket.on(THREAD_OPEN_EVENT, async (raw: unknown) => {
    if (isRateLimited(socket.id, 60, 10_000)) return;
    const parsed = threadOpenSchema.safeParse(raw);
    if (!parsed.success) return;
    const { threadId } = parsed.data;

    // Gate: only the owner or a current sharee may join. A denied open is
    // silent — the caller simply never receives presence/stream for the thread.
    if (!(await canUserViewThread(threadId, userId))) {
      log.warn('Rejected thread:open — no view access', {
        namespace: 'socketio',
        userId,
        threadId,
      });
      return;
    }

    const display = (await getUserDisplay(userId)) ?? { id: userId, name: userId, image: null };
    const viewer: Viewer = { clientId: socket.id, user: display };

    socket.join(threadPresenceRoom(threadId));
    // Sharees join the stream room to receive the mirrored agent stream; the
    // owner does NOT (they get it via `user:` already — avoids double delivery).
    if (!(await isThreadOwnedBy(threadId, userId))) {
      socket.join(threadStreamRoom(threadId));
    }

    let roster = presenceByThread.get(threadId);
    if (!roster) {
      roster = new Map();
      presenceByThread.set(threadId, roster);
    }
    // Send the current roster to the joining socket BEFORE adding itself, then
    // announce the join to everyone else.
    socket.emit(PRESENCE_SYNC_EVENT, { threadId, viewers: rosterFor(threadId) });
    roster.set(socket.id, viewer);
    openThreads.add(threadId);
    socket.to(threadPresenceRoom(threadId)).emit(PRESENCE_JOIN_EVENT, { threadId, viewer });
  });

  socket.on(THREAD_CLOSE_EVENT, (raw: unknown) => {
    const parsed = threadOpenSchema.safeParse(raw);
    if (!parsed.success) return;
    leaveThread(socket, parsed.data.threadId);
  });

  socket.on('disconnect', () => {
    for (const threadId of Array.from(openThreads)) {
      leaveThread(socket, threadId);
    }
  });
}

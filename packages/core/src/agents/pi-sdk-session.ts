type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type SessionManagerCtor = PiSdk['SessionManager'];
type SessionManagerInstance = ReturnType<SessionManagerCtor['create']>;

export interface PiSessionRef {
  sessionId: string;
  sessionFile: string;
}

export interface ForkPiSessionOptions {
  sessionId: string;
  cwd: string;
  userMessageIndex?: number;
}

export type ForkPiSessionResult =
  | { ok: true; newSessionId: string }
  | {
      ok: false;
      reason: 'session_not_found' | 'message_not_found' | 'fork_failed';
      message?: string;
    };

export async function findPiSessionById(
  cwd: string,
  sessionId: string,
): Promise<PiSessionRef | null> {
  const SessionManager = await loadSessionManager();
  const sessions = await SessionManager.list(cwd);
  const hit = sessions.find((s) => s.id === sessionId);
  return hit ? { sessionId: hit.id, sessionFile: hit.path } : null;
}

export async function createPiSessionManager(
  cwd: string,
  sessionId?: string,
): Promise<SessionManagerInstance> {
  const SessionManager = await loadSessionManager();
  if (sessionId) {
    const existing = await findPiSessionById(cwd, sessionId);
    if (existing) return SessionManager.open(existing.sessionFile, undefined, cwd);
  }
  return SessionManager.create(cwd);
}

export async function forkPiSession(opts: ForkPiSessionOptions): Promise<ForkPiSessionResult> {
  const SessionManager = await loadSessionManager();
  const existing = await findPiSessionById(opts.cwd, opts.sessionId);
  if (!existing) {
    return {
      ok: false,
      reason: 'session_not_found',
      message: `Pi session '${opts.sessionId}' was not found for cwd '${opts.cwd}'`,
    };
  }

  try {
    const source = SessionManager.open(existing.sessionFile, undefined, opts.cwd);
    const userEntries = source
      .getEntries()
      .filter((entry) => entry.type === 'message' && (entry as any).message?.role === 'user');
    const target =
      typeof opts.userMessageIndex === 'number' ? userEntries[opts.userMessageIndex] : undefined;
    const leafId = target?.id ?? source.getLeafId();
    if (!leafId) {
      return {
        ok: false,
        reason: 'message_not_found',
        message: 'Pi session has no branch point to fork',
      };
    }

    const forkedFile = source.createBranchedSession(leafId);
    if (!forkedFile) {
      return {
        ok: false,
        reason: 'fork_failed',
        message: 'Pi session manager did not create a branched session file',
      };
    }
    const forked = SessionManager.open(forkedFile, undefined, opts.cwd);
    return { ok: true, newSessionId: forked.getSessionId() };
  } catch (err) {
    return {
      ok: false,
      reason: 'fork_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadSessionManager(): Promise<SessionManagerCtor> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  return sdk.SessionManager;
}

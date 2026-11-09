type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type SessionManagerCtor = PiSdk['SessionManager'];
type SessionManagerInstance = ReturnType<SessionManagerCtor['create']>;

export interface PiSessionRef {
  sessionId: string;
  sessionFile: string;
}

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

async function loadSessionManager(): Promise<SessionManagerCtor> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  return sdk.SessionManager;
}

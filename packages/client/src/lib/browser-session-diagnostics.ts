const MAX_TRACKED_SESSIONS = 16;

export interface BrowserSessionDiagnosticCounters {
  framesReceived: number;
  payloadBase64Chars: number;
  latestPayloadBase64Chars: number;
  decodesStarted: number;
  decodesCompleted: number;
  decodeFailures: number;
  decodesSuperseded: number;
  lastFrameAt: number | null;
}

export interface BrowserSessionDiagnosticEntry extends BrowserSessionDiagnosticCounters {
  sessionId: string;
}

export interface BrowserSessionDiagnosticsSnapshot {
  totals: BrowserSessionDiagnosticCounters;
  trackedSessions: BrowserSessionDiagnosticEntry[];
}

function emptyCounters(): BrowserSessionDiagnosticCounters {
  return {
    framesReceived: 0,
    payloadBase64Chars: 0,
    latestPayloadBase64Chars: 0,
    decodesStarted: 0,
    decodesCompleted: 0,
    decodeFailures: 0,
    decodesSuperseded: 0,
    lastFrameAt: null,
  };
}

let totals = emptyCounters();
const sessions = new Map<string, BrowserSessionDiagnosticCounters>();

function getSession(sessionId: string): BrowserSessionDiagnosticCounters {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  if (sessions.size >= MAX_TRACKED_SESSIONS) {
    const oldestSessionId = sessions.keys().next().value;
    if (oldestSessionId !== undefined) sessions.delete(oldestSessionId);
  }

  const counters = emptyCounters();
  sessions.set(sessionId, counters);
  return counters;
}

export function recordBrowserSessionFrame(
  sessionId: string,
  payloadBase64Chars: number,
  timestamp: number = Date.now(),
): void {
  const session = getSession(sessionId);
  session.framesReceived++;
  session.payloadBase64Chars += payloadBase64Chars;
  session.latestPayloadBase64Chars = payloadBase64Chars;
  session.lastFrameAt = timestamp;

  totals.framesReceived++;
  totals.payloadBase64Chars += payloadBase64Chars;
  totals.latestPayloadBase64Chars = payloadBase64Chars;
  totals.lastFrameAt = timestamp;
}

export function recordBrowserSessionDecodeStarted(
  sessionId: string,
  supersededPendingDecode: boolean,
): void {
  const session = getSession(sessionId);
  session.decodesStarted++;
  totals.decodesStarted++;
  if (supersededPendingDecode) {
    session.decodesSuperseded++;
    totals.decodesSuperseded++;
  }
}

export function recordBrowserSessionDecodeCompleted(sessionId: string): void {
  getSession(sessionId).decodesCompleted++;
  totals.decodesCompleted++;
}

export function recordBrowserSessionDecodeFailed(sessionId: string): void {
  getSession(sessionId).decodeFailures++;
  totals.decodeFailures++;
}

export function clearBrowserSessionDiagnostics(sessionId: string): void {
  sessions.delete(sessionId);
}

export function getBrowserSessionDiagnostics(): BrowserSessionDiagnosticsSnapshot {
  return {
    totals: { ...totals },
    trackedSessions: Array.from(sessions, ([sessionId, counters]) => ({
      sessionId,
      ...counters,
    })),
  };
}

/** Test seam for resetting module-level counters between unit tests. */
export function resetBrowserSessionDiagnosticsForTests(): void {
  totals = emptyCounters();
  sessions.clear();
}

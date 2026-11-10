import {
  authorizedRunnerTerminal,
  runnerActor,
  type RunnerAccess,
} from '../runner-access/index.js';
import type { RunnerPresencePort, RunnerTerminalPort } from '../runner-ports.js';
import { terminalRoutesOf } from './terminal-targets.js';

type Session = Record<string, unknown>;

/**
 * Adds the sessions living on the runners of the user's other terminal routes
 * to a general runner's listing. A sandbox thread's terminal runs on the
 * sandbox's runner, so without this a reload never lists it and the client
 * opens a fresh shell instead of reattaching. Each route is certified by
 * `withRunnerFor`; one that is unavailable adds nothing.
 */
export async function withRoutedTerminalSessions(
  sessions: Session[],
  userId: string,
  dependencies: {
    access: RunnerAccess;
    terminals?: RunnerTerminalPort;
    presence?: RunnerPresencePort;
    /** A listing asked of one named runner: only that runner's sessions. */
    onlyRunnerId?: string;
  },
): Promise<Session[]> {
  if (dependencies.onlyRunnerId) return sessions;
  const sink = authorizedRunnerTerminal(dependencies.terminals);
  const merged = [...sessions];
  const seen = new Set(sessions.map((session) => session.ptyId));
  for (const target of terminalRoutesOf(userId)) {
    const listed = await dependencies.access.withRunnerFor(
      runnerActor({ userId }),
      target,
      dependencies.presence,
      async (actor, runner, proof) =>
        (await sink.isAvailable(runner)) ? sink.listSessions(actor, runner, proof) : [],
    );
    for (const session of listed.unwrapOr([])) {
      if (seen.has(session.ptyId)) continue;
      seen.add(session.ptyId);
      merged.push(session);
    }
  }
  return merged;
}

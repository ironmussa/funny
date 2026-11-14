/**
 * Not paying for an idle sandbox while its pull request waits (#290). After a
 * step, the run's sandbox is paused: stopped where the provider keeps the disk
 * on stop (resumed for the next fix), else destroyed. Before a destroy the
 * agent's sessions (`~/.claude/projects`) are kept on the host, and put back in
 * the sandbox made again from the pull request branch, so a fix still resumes
 * the session of the implementation.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { WorkspaceRequest } from '../ports/workspaces.js';
import type { SandboxRecord, SandboxSession, SandboxWorkspaceDeps } from './sandbox-session.js';

/** Base64 written to the sandbox per `exec` (well under a command line's limit). */
const CHUNK = 64 * 1024;
const SESSIONS = '.claude/projects';

export function createSandboxPause(session: SandboxSession, deps: SandboxWorkspaceDeps) {
  const { provider, recordPath } = session;
  const archivePath = (request: WorkspaceRequest) => join(request.runDir, 'agent-sessions.tgz.b64');
  const pausedPath = (request: WorkspaceRequest) => join(request.runDir, 'sandbox-paused');
  const warn = (message: string, request: WorkspaceRequest, error: unknown) =>
    deps.log.warn(message, { run: request.runId, error: String(error) });

  /** The agent's sessions, out of the sandbox and onto the host. */
  async function keepSessions(record: SandboxRecord, request: WorkspaceRequest): Promise<boolean> {
    const packed = await provider.exec(
      record.handle,
      `cd "$HOME" && if [ -d ${SESSIONS} ]; then tar -czf - ${SESSIONS} | base64 -w0; fi`,
    );
    if (packed.isErr() || packed.value.exitCode !== 0) {
      warn(
        'Could not keep the agent sessions',
        request,
        packed.isErr() ? packed.error.message : packed.value.stderr,
      );
      return false;
    }
    await mkdir(request.runDir, { recursive: true });
    await writeFile(archivePath(request), packed.value.stdout.trim(), { mode: 0o600 });
    return true;
  }

  /** Stop the sandbox, or destroy it with its sessions kept, after a step. */
  async function pause(record: SandboxRecord, request: WorkspaceRequest): Promise<void> {
    if (provider.capabilities().stopPreservesDisk) {
      const stopped = await provider.stop(record.handle);
      if (stopped.isErr()) warn('Could not stop the sandbox', request, stopped.error.message);
      return;
    }
    // Without its sessions a new sandbox could not resume the agent: keep this one.
    if (!(await keepSessions(record, request))) return;
    const destroyed = await provider.destroy(record.handle);
    if (destroyed.isErr())
      return warn('Could not destroy the sandbox', request, destroyed.error.message);
    await rm(recordPath(request), { force: true });
    await writeFile(pausedPath(request), new Date().toISOString());
  }

  /** Put the kept sessions back in a sandbox made again for the run. */
  async function restoreSessions(record: SandboxRecord, request: WorkspaceRequest): Promise<void> {
    const archive = await readFile(archivePath(request), 'utf8').catch(() => '');
    if (!archive) return;
    const file = '"$HOME"/.factory-sessions.b64';
    await provider.exec(record.handle, `: > ${file}`);
    for (let at = 0; at < archive.length; at += CHUNK) {
      await provider.exec(record.handle, `printf %s '${archive.slice(at, at + CHUNK)}' >> ${file}`);
    }
    const unpacked = await provider.exec(
      record.handle,
      `cd "$HOME" && base64 -d ${file} | tar -xzf - && rm -f ${file}`,
    );
    if (unpacked.isErr() || unpacked.value.exitCode !== 0) {
      warn(
        'Could not restore the agent sessions',
        request,
        unpacked.isErr() ? unpacked.error.message : unpacked.value.stderr,
      );
    }
  }

  /** Forget a pause (the run's workspace is removed for good). */
  const clear = (request: WorkspaceRequest) =>
    Promise.all([
      rm(archivePath(request), { force: true }),
      rm(pausedPath(request), { force: true }),
    ]);

  /** Whether the run's sandbox was destroyed on purpose, to be made again for a fix. */
  const paused = (request: WorkspaceRequest) => existsSync(pausedPath(request));

  return { pause, restoreSessions, clear, paused };
}

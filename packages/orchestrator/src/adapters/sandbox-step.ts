/**
 * A factory run's steps in its sandbox (#289). `exec` returns only when its
 * command ends, so a step starts detached; the orchestrator then polls with
 * short `exec` calls: it renews the run's token inside the sandbox when due,
 * mirrors the step's event file to the run's event file on the host, and
 * reads the exit marker.
 */

import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS } from '@funny/shared/github-app-token';

import { stepOutcomeSchema, type StepOutcome } from '../domain/step-outcome.js';
import type { RunWorkspace, WorkspaceRequest } from '../ports/workspaces.js';
import {
  b64,
  MAX_STEP_MS,
  POLL_MS,
  q,
  type SandboxRecord,
  type SandboxSession,
  type SandboxWorkspaceDeps,
} from './sandbox-session.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const infra = (reason: string): StepOutcome => ({
  kind: 'failed',
  failure: 'infra',
  reason,
});

export function sandboxRunWorkspace(
  session: SandboxSession,
  deps: SandboxWorkspaceDeps,

  record: SandboxRecord,
  request: WorkspaceRequest,
  tokenExpiry: number,
  /** After a step: the sandbox is paused while the pull request waits. */
  pause: () => Promise<void>,
): RunWorkspace {
  const { provider, paths, writeToken, exec } = session;
  const p = paths(record, request.runId);
  let expiry = tokenExpiry;
  /** Bytes of the step event file already on the host, kept across steps and restarts. */
  const offsetFile = join(request.runDir, 'sandbox-events.offset');
  const readOffset = () =>
    readFile(offsetFile, 'utf8').then(
      (text) => Number(text.trim()) || 0,
      () => 0,
    );

  /** New lines of the step's event file, appended to the run's event file on the host. */
  async function mirrorEvents(): Promise<void> {
    const mirrored = await readOffset();
    const tail = await provider.exec(
      record.handle,
      `tail -c +${mirrored + 1} ${q(p.events)} 2>/dev/null || true`,
    );
    if (tail.isErr() || !tail.value.stdout) return;
    const complete = tail.value.stdout.slice(0, tail.value.stdout.lastIndexOf('\n') + 1);
    if (!complete) return;
    try {
      await mkdir(request.runDir, { recursive: true });
      await appendFile(request.eventsPath, complete);
      await writeFile(offsetFile, String(mirrored + Buffer.byteLength(complete)));
    } catch (error) {
      deps.log.warn('Could not mirror the step events', {
        run: request.runId,
        error: String(error),
      });
    }
  }

  /** Stop the step (it ran past its time). */
  const stopStep = () =>
    provider.exec(
      record.handle,
      `[ -f ${q(p.pid)} ] && kill "$(cat ${q(p.pid)})" 2>/dev/null; true`,
    );

  /** Renew the run's token inside the sandbox before it expires. */
  async function renewIfDue(): Promise<void> {
    if (expiry - deps.clock.now().getTime() > GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS) return;
    const renewed = await writeToken(record, request);
    if (renewed.isOk()) expiry = renewed.value;
    else
      deps.log.warn('Could not renew the factory run token', {
        run: request.runId,
        error: renewed.error,
      });
  }

  async function readMarker(): Promise<StepOutcome | null> {
    const read = await provider.exec(record.handle, `cat ${q(p.exitMarker)} 2>/dev/null || true`);
    if (read.isErr() || !read.value.stdout.trim()) return null;
    try {
      const marker = stepOutcomeSchema.safeParse(JSON.parse(read.value.stdout));
      return marker.success ? marker.data : infra('the step wrote an unexpected exit marker');
    } catch {
      return infra('the step wrote an unreadable exit marker');
    }
  }

  async function runStep(step: 'implement' | 'fix', spec: object): Promise<StepOutcome> {
    const full = { ...spec, eventsPath: p.events, exitMarkerPath: p.exitMarker };
    const started = await exec(
      record.handle,
      'starting the step',
      [
        `rm -f ${q(p.exitMarker)}`,
        `printf %s ${q(b64(JSON.stringify(full)))} | base64 -d > ${q(p.spec)}`,
        `cd ${q(p.repo)}`,
        // Only the step goes to the background, in its own session, with no tie
        // to this exec's output: the exec ends at once, and with what came before.
        `(setsid nohup ${q(`${p.work}/bin/run-step`)} ${step} --spec ${q(p.spec)} > ${q(`${p.work}/step.log`)} 2>&1 < /dev/null &)`,
      ].join(' && '),
    );
    if (started.isErr()) return infra(started.error);
    const deadline = Date.now() + (deps.maxStepMs ?? MAX_STEP_MS);
    while (Date.now() < deadline) {
      await sleep(deps.pollIntervalMs ?? POLL_MS);
      await renewIfDue();
      await mirrorEvents();
      const outcome = await readMarker();
      if (outcome) {
        await mirrorEvents();
        return outcome;
      }
    }
    await stopStep();
    return infra('the step did not finish in time');
  }

  return {
    cwd: p.repo,
    implement: (spec) => runStep('implement', spec),
    fix: (spec) => runStep('fix', spec),
    release: pause,
  };
}

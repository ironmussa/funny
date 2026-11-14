/**
 * A factory run's sandbox, at the level of `exec` (#289): where its files are,
 * its root-only secrets, its git and gh configuration and step launcher, the
 * clone of the repository, and making a sandbox of the runner template. See
 * `sandbox-workspace.ts` for how a run uses it.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import type {
  RunnerTemplateManager,
  SandboxError,
  SandboxHandle,
  SandboxProvider,
} from '@funny/sandbox';
import { pollUntil } from '@funny/sandbox';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { FactoryLog } from '../infrastructure/factory-log.js';
import type { Clock } from '../ports/clock.js';
import type { WorkspaceRequest } from '../ports/workspaces.js';
import type { FactoryAppTokens } from './factory-app.js';

/** Where things live inside the sandbox. Tests point them into a temp directory. */
export interface SandboxLayout {
  /** Root-only directory of the runs' secrets. */
  secretsRoot: string;
  /** Prefix of commands that must run as root (empty where the sandbox user is root). */
  sudo: string;
  /** The step runner inside the template. */
  stepBin: string;
  bun: string;
  /** Clone URL of a repository. */
  cloneUrl(repo: string): string;
}

const DEFAULT_SANDBOX_LAYOUT: SandboxLayout = {
  secretsRoot: '/etc/funny-factory',
  sudo: 'sudo',
  stepBin: '/opt/funny/packages/agent/src/bin/step.ts',
  bun: 'bun',
  cloneUrl: (repo) => `https://github.com/${repo}.git`,
};

export interface SandboxWorkspaceDeps {
  provider: SandboxProvider;
  templates: RunnerTemplateManager;
  /** Identifies the provider account for the template manager. */
  accountKey: string;
  sizeId: string;
  tokens: FactoryAppTokens;
  clock: Clock;
  log: FactoryLog;
  modelKey: string;
  author: { name: string; email: string };
  layout?: Partial<SandboxLayout>;
  /** Between two looks at a running step (real time). */
  pollIntervalMs?: number;
  /** A step running longer than this is an infrastructure failure. */
  maxStepMs?: number;
}

export const POLL_MS = 5_000;
export const MAX_STEP_MS = 6 * 60 * 60 * 1000;
const BOOT_TIMEOUT_MS = 10 * 60 * 1000;

/** A value safe inside single quotes in sh. */
export const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const failure = (e: SandboxError | string) =>
  typeof e === 'string' ? e : `${e.kind}: ${e.message}`;

/** The run's sandbox, recorded next to its host files. */
export interface SandboxRecord {
  handle: SandboxHandle;
  /** The sandbox user's home. */
  home: string;
}

export function createSandboxSession(deps: SandboxWorkspaceDeps) {
  const layout = { ...DEFAULT_SANDBOX_LAYOUT, ...deps.layout };
  const { provider } = deps;
  const recordPath = (request: WorkspaceRequest) => join(request.runDir, 'sandbox.json');

  /** Run a shell command in the sandbox; a non-zero exit is an error naming `what`. */
  const exec = (handle: SandboxHandle, what: string, command: string) =>
    provider
      .exec(handle, command, { timeoutMs: 10 * 60 * 1000 })
      .mapErr(failure)
      .andThen((run) =>
        run.exitCode === 0
          ? okAsync(run.stdout)
          : errAsync(
              `${what} failed (${run.exitCode}): ${(run.stderr || run.stdout).trim().slice(-2000)}`,
            ),
      );

  /** The paths of a run in the sandbox. */
  const paths = (record: SandboxRecord, runId: string) => {
    const work = `${record.home}/factory/${runId}`;
    const secrets = `${layout.secretsRoot}/${runId}`;
    return {
      work,
      repo: `${work}/repo`,
      spec: `${work}/spec.json`,
      events: `${work}/events.jsonl`,
      exitMarker: `${work}/exit.json`,
      pid: `${work}/step.pid`,
      secrets,
      token: `${secrets}/github-token`,
      modelKey: `${secrets}/model-key`,
    };
  };

  /**
   * Write `value` to a root-only file, never through the create request. A
   * provider that writes files gets the value outside any command (a provider
   * may keep its commands, Boat does): it lands in the user's home and is moved
   * into place. Otherwise it goes through `exec`, encoded.
   */
  const writeSecret = (record: SandboxRecord, file: string, value: string) => {
    const into = (input: string) =>
      `${layout.sudo} tee ${q(file)} ${input} >/dev/null && ${layout.sudo} chmod 600 ${q(file)}`;
    if (!provider.writeFile) {
      return exec(
        record.handle,
        'writing a secret',
        `printf %s ${q(b64(value))} | base64 -d | ${into('')}`,
      );
    }
    const staged = `${record.home}/.funny-secret-${randomUUID()}`;
    return provider
      .writeFile(record.handle, staged, value)
      .mapErr(failure)
      .andThen(() =>
        exec(
          record.handle,
          'writing a secret',
          `${into(`< ${q(staged)}`)}; moved=$?; rm -f ${q(staged)}; exit $moved`,
        ),
      );
  };

  const writeToken = (record: SandboxRecord, request: WorkspaceRequest) =>
    deps.tokens
      .forRepo(request.repo)
      .mapErr((e) => `no GitHub token: ${e.message}`)
      .andThen((token) =>
        writeSecret(record, paths(record, request.runId).token, token.token).map(() =>
          Date.parse(token.expiresAt),
        ),
      );

  /** The run's directories, secrets, git and gh configuration, and step launcher. */
  function setUp(record: SandboxRecord, request: WorkspaceRequest) {
    const p = paths(record, request.runId);
    const readToken = `${layout.sudo} cat ${p.token}`;
    const gitconfig = [
      '[credential "https://github.com"]',
      '\thelper =',
      `\thelper = "!f() { echo username=x-access-token; echo password=$(${readToken}); }; f"`,
    ].join('\n');
    const env = [
      `HOME=${q(record.home)}`,
      `GIT_CONFIG_GLOBAL=${q(`${p.work}/gitconfig`)}`,
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_TERMINAL_PROMPT=0',
      'GH_PROMPT_DISABLED=1',
      'GH_NO_UPDATE_NOTIFIER=1',
      `GIT_AUTHOR_NAME=${q(deps.author.name)}`,
      `GIT_AUTHOR_EMAIL=${q(deps.author.email)}`,
      `GIT_COMMITTER_NAME=${q(deps.author.name)}`,
      `GIT_COMMITTER_EMAIL=${q(deps.author.email)}`,
      `FACTORY_GITHUB_TOKEN_FILE=${q(p.token)}`,
    ].join('\n');
    const ghWrapper = [
      '#!/bin/sh',
      'if [ -z "$FACTORY_REAL_GH" ]; then echo "gh is not installed in the sandbox" >&2; exit 127; fi',
      // gh reads the current token on every call: a renewal applies at once.
      `GH_TOKEN="$(${readToken})" exec "$FACTORY_REAL_GH" "$@"`,
    ].join('\n');
    const runStep = [
      '#!/usr/bin/env bash',
      'set -a',
      `. ${q(`${p.work}/step.env`)}`,
      'set +a',
      `export PATH=${q(`${p.work}/bin`)}:"$PATH"`,
      `export ANTHROPIC_API_KEY="$(${layout.sudo} cat ${q(p.modelKey)})"`,
      `echo $$ > ${q(p.pid)}`,
      `exec ${layout.bun} ${q(layout.stepBin)} "$@"`,
    ].join('\n');
    const file = (path: string, content: string, mode: string) =>
      `printf %s ${q(b64(content))} | base64 -d > ${q(path)} && chmod ${mode} ${q(path)}`;
    const command = [
      'set -e',
      `mkdir -p ${q(`${p.work}/bin`)}`,
      `${layout.sudo} mkdir -p ${q(p.secrets)} && ${layout.sudo} chmod 700 ${q(p.secrets)}`,
      file(`${p.work}/gitconfig`, gitconfig, '600'),
      file(`${p.work}/step.env`, `${env}\n`, '600'),
      // The real gh, looked up now, before the wrapper shadows it on PATH.
      `echo "FACTORY_REAL_GH=$(command -v gh || true)" >> ${q(`${p.work}/step.env`)}`,
      file(`${p.work}/bin/gh`, ghWrapper, '700'),
      file(`${p.work}/bin/run-step`, runStep, '700'),
    ].join(' && ');
    return exec(record.handle, 'setting up the sandbox', command)
      .andThen(() => writeSecret(record, p.modelKey, deps.modelKey))
      .andThen(() => writeToken(record, request));
  }

  /** Clone the repository with the run's token: a new branch from the base, or the run's own. */
  function clone(record: SandboxRecord, request: WorkspaceRequest, fromBranch: boolean) {
    const p = paths(record, request.runId);
    const checkout = fromBranch
      ? `git checkout -q -B ${q(request.branch)} ${q(`origin/${request.branch}`)}`
      : `git checkout -q -b ${q(request.branch)} ${q(`origin/${request.base}`)}`;
    return exec(
      record.handle,
      'cloning the repository',
      `set -e; set -a; . ${q(`${p.work}/step.env`)}; set +a; rm -rf ${q(p.repo)}; git clone --quiet ${q(layout.cloneUrl(request.repo))} ${q(p.repo)}; cd ${q(p.repo)}; ${checkout}`,
    );
  }

  /** A new sandbox of the runner template, running, with its user's home. */
  function boot(request: WorkspaceRequest): ResultAsync<SandboxRecord, string> {
    const caps = provider.capabilities();
    return deps.templates
      .ensure(deps.accountKey, provider)
      .andThen((template) =>
        provider.create({
          ownerKey: request.runId,
          sizeId: deps.sizeId,
          template,
          // Bootstrap only, and the factory needs none: secrets go through `writeSecret`.
          env: {},
          lifetimeMs: caps.maxLifetimeMs ?? undefined,
          // A new sandbox each time: a rebuilt one must not be answered with the one gone.
          idempotencyKey: `${request.runId}:${randomUUID()}`,
        }),
      )
      .andThen((handle) =>
        pollUntil(
          () =>
            provider.status(handle).map((status) => (status.state === 'running' ? handle : null)),
          { what: 'the sandbox to start', timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 2_000 },
        ),
      )
      .mapErr(failure)
      .andThen((handle) =>
        exec(handle, 'reading the sandbox home', 'printf %s "$HOME"').map(
          (home): SandboxRecord => ({ handle, home: home.trim() }),
        ),
      );
  }

  const save = (request: WorkspaceRequest, record: SandboxRecord) =>
    ResultAsync.fromPromise(
      mkdir(request.runDir, { recursive: true }).then(() =>
        writeFile(recordPath(request), `${JSON.stringify(record)}\n`, { mode: 0o600 }),
      ),
      (error) => `cannot record the sandbox: ${String(error)}`,
    ).map(() => record);

  const load = (request: WorkspaceRequest) =>
    ResultAsync.fromPromise(
      readFile(recordPath(request), 'utf8').then((text) => JSON.parse(text) as SandboxRecord),
      () => 'the run has no sandbox',
    );

  return { provider, layout, recordPath, exec, paths, writeToken, setUp, clone, boot, save, load };
}

export type SandboxSession = ReturnType<typeof createSandboxSession>;

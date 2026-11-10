/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * Keeps one runner template per (provider account, server build) without
 * manual maintenance (change thread-sandboxes): builds it on demand or in the
 * background after a deploy, dedupes concurrent builds, and deletes templates of
 * older builds once the new one is ready.
 */

import { errAsync, okAsync, ResultAsync, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { SandboxError, SandboxProvider, TemplateRef } from './contract.js';
import type { RunnerBuild } from './runner-build.js';
import { RUNNER_INSTALL_SCRIPT, runnerInstallEnv } from './runner-install-script.js';

export interface RunnerTemplateManager {
  /** The ready template of this build, or null when none is ready yet. Never builds. */
  current(provider: SandboxProvider): ResultAsync<TemplateRef | null, SandboxError>;
  /**
   * The ready template of this build, building it when missing. `accountKey`
   * identifies the provider account (e.g. the connection id); concurrent calls
   * with the same key share one build.
   */
  ensure(accountKey: string, provider: SandboxProvider): ResultAsync<TemplateRef, SandboxError>;
  isBuilding(accountKey: string): boolean;
}

/** Errors meaning the account cannot hold templates right now (not transient). */
const TEMPLATES_UNAVAILABLE = new Set<SandboxError['kind']>(['unsupported', 'quota']);
const UNAVAILABLE_TTL_MS = 60 * 60 * 1000;

export function createRunnerTemplateManager(build: RunnerBuild): RunnerTemplateManager {
  const inFlight = new Map<string, Promise<Result<TemplateRef, SandboxError>>>();

  const current = (provider: SandboxProvider) =>
    provider
      .resolveTemplate(build.version)
      .map((ref): TemplateRef | null => ref)
      .orElse((error) =>
        error.kind === 'template-missing'
          ? okAsync<TemplateRef | null, SandboxError>(null)
          : errAsync<TemplateRef | null, SandboxError>(error),
      );

  /** Best effort: a failed cleanup never fails the build that triggered it. */
  const cleanupOlder = (provider: SandboxProvider, keep: TemplateRef) => {
    if (!provider.listTemplates || !provider.deleteTemplate) return okAsync(undefined);
    const remove = provider.deleteTemplate.bind(provider);
    return provider
      .listTemplates()
      .andThen((templates) =>
        ResultAsync.combine(templates.filter((t) => t.ref !== keep.ref).map((t) => remove(t))),
      )
      .map(() => undefined)
      .orElse((error) => {
        log.warn('Old runner template cleanup failed', {
          namespace: 'thread-sandboxes',
          provider: provider.id,
          error: error.message,
        });
        return okAsync(undefined);
      });
  };

  const buildNow = (provider: SandboxProvider): ResultAsync<TemplateRef, SandboxError> => {
    if (!provider.buildTemplate) {
      return errAsync({
        kind: 'unsupported',
        message: `${provider.id} cannot build runner templates`,
      });
    }
    const startedAt = Date.now();
    log.info('Building runner template', {
      namespace: 'thread-sandboxes',
      provider: provider.id,
      version: build.version,
    });
    return provider
      .buildTemplate({
        serverVersion: build.version,
        installScript: RUNNER_INSTALL_SCRIPT,
        scriptEnv: runnerInstallEnv(build, { buildNative: true }),
      })
      .andTee(() =>
        metric('thread_sandboxes.template_build_ms', Date.now() - startedAt, {
          type: 'gauge',
          unit: 'ms',
          attributes: { provider: provider.id },
        }),
      )
      .andThrough((ref) => cleanupOlder(provider, ref));
  };

  /** Accounts that cannot hold templates (plan limits): skip rebuild attempts for a while. */
  const unavailable = new Map<string, { error: SandboxError; until: number }>();

  return {
    current,
    isBuilding: (accountKey) => inFlight.has(`${accountKey}:${build.version}`),
    ensure(accountKey, provider) {
      const key = `${accountKey}:${build.version}`;
      const blocked = unavailable.get(key);
      if (blocked && blocked.until > Date.now()) return errAsync(blocked.error);
      const pending = inFlight.get(key);
      if (pending) return new ResultAsync(pending);
      const run = (async () => {
        const result = await current(provider).andThen((ref) =>
          ref ? okAsync<TemplateRef, SandboxError>(ref) : buildNow(provider),
        );
        inFlight.delete(key);
        if (result.isErr() && TEMPLATES_UNAVAILABLE.has(result.error.kind)) {
          unavailable.set(key, { error: result.error, until: Date.now() + UNAVAILABLE_TTL_MS });
          log.warn('Runner templates unavailable for this provider account', {
            namespace: 'thread-sandboxes',
            provider: provider.id,
            reason: result.error.message,
          });
        }
        return result;
      })();
      inFlight.set(key, run);
      return new ResultAsync(run);
    },
  };
}

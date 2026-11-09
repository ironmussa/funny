/**
 * Keeps one reverse-link dialer per sandbox that needs it (change
 * thread-sandboxes). Level-triggered: each `sync` reads the sandboxes whose
 * runner uses the reverse link and is (or is about to be) up, starts a dialer
 * for each new one — publishing its port through the provider first — and
 * closes the dialers of sandboxes that stopped, failed or are gone. A server
 * restart, a stop/resume or an expired ingress token all converge on the next
 * pass; nothing in the lifecycle code has to know the link exists.
 */

import { REVERSE_LINK_INGRESS_PORT } from '@funny/shared/reverse-link';
import type { ResultAsync } from 'neverthrow';

import { log } from '../../../lib/logger.js';
import type { SandboxIngress, SandboxProvider } from '../contract.js';
import type { ReverseLinkDialer } from './dialer.js';

/** States in which the sandbox runner is started and needs the server. */
export const REVERSE_LINK_STATES = ['connecting', 'bootstrapping', 'running'] as const;

export interface ReverseLinkedSandbox {
  threadId: string;
  generation: number;
  userId: string;
  connectionId: string;
  sandboxId: string;
}

export interface ReverseLinkSupervisorDeps {
  /** Sandboxes with `runner_link = reverse` in a `REVERSE_LINK_STATES` state. */
  listLinked(): ResultAsync<ReverseLinkedSandbox[], string>;
  providerFor(sandbox: ReverseLinkedSandbox): ResultAsync<SandboxProvider, string>;
  secretFor(sandbox: ReverseLinkedSandbox): string;
  startDialer(input: {
    sandbox: ReverseLinkedSandbox;
    ingress: SandboxIngress;
    secret: string;
    onUnhealthy: () => void;
  }): ReverseLinkDialer;
  /** Retry delays of a sandbox whose link failed to start (defaults: 3 s doubling to 60 s). */
  retry?: { baseMs: number; maxMs: number };
  now?: () => number;
}

export interface ReverseLinkSupervisor {
  sync(): Promise<{ linked: number; started: number; stopped: number }>;
  linkedCount(): number;
  close(): void;
}

const keyOf = (s: ReverseLinkedSandbox) => `${s.threadId}:${s.generation}:${s.sandboxId}`;

export function createReverseLinkSupervisor(
  deps: ReverseLinkSupervisorDeps,
): ReverseLinkSupervisor {
  const dialers = new Map<string, ReverseLinkDialer>();
  /** Sandboxes whose dialer is being set up, so overlapping passes do not double it. */
  const starting = new Set<string>();
  /**
   * Back-off of sandboxes whose link failed to start: a booting machine is
   * retried soon, a permanent failure (connection deleted, machine gone) does
   * not hit the provider API and the log on every pass.
   */
  const retryAt = new Map<string, { at: number; delayMs: number }>();
  const retry = deps.retry ?? { baseMs: 3_000, maxMs: 60_000 };
  const now = deps.now ?? Date.now;

  const stop = (key: string) => {
    dialers.get(key)?.close();
    dialers.delete(key);
  };

  const start = async (sandbox: ReverseLinkedSandbox, key: string): Promise<boolean> => {
    starting.add(key);
    try {
      const provider = await deps.providerFor(sandbox);
      if (provider.isErr()) throw new Error(provider.error);
      const p = provider.value;
      if (!p.exposePort) throw new Error(`${p.id} cannot publish a port`);
      const handle = { providerId: p.id, sandboxId: sandbox.sandboxId };
      const ingress = await p.exposePort(handle, REVERSE_LINK_INGRESS_PORT);
      if (ingress.isErr()) throw new Error(`${ingress.error.kind}: ${ingress.error.message}`);
      dialers.set(
        key,
        deps.startDialer({
          sandbox,
          ingress: ingress.value,
          secret: deps.secretFor(sandbox),
          // Fresh credentials on the next pass (an expired or rotated token).
          onUnhealthy: () => stop(key),
        }),
      );
      retryAt.delete(key);
      return true;
    } catch (error) {
      const previous = retryAt.get(key)?.delayMs;
      const delayMs = previous ? Math.min(previous * 2, retry.maxMs) : retry.baseMs;
      retryAt.set(key, { at: now() + delayMs, delayMs });
      // The machine may still be booting: retried once the delay has passed.
      log.warn('Reverse link not established yet', {
        namespace: 'reverse-link',
        threadId: sandbox.threadId,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      starting.delete(key);
    }
  };

  return {
    async sync() {
      const listed = await deps.listLinked();
      if (listed.isErr()) {
        log.error('Reverse link pass could not list sandboxes', {
          namespace: 'reverse-link',
          error: listed.error,
        });
        return { linked: dialers.size, started: 0, stopped: 0 };
      }
      const wanted = new Map(listed.value.map((s) => [keyOf(s), s]));
      let stopped = 0;
      for (const key of [...dialers.keys()]) {
        if (!wanted.has(key)) {
          stop(key);
          stopped += 1;
        }
      }
      for (const key of [...retryAt.keys()]) if (!wanted.has(key)) retryAt.delete(key);
      const due = (key: string) => (retryAt.get(key)?.at ?? 0) <= now();
      const fresh = [...wanted].filter(
        ([key]) => !dialers.has(key) && !starting.has(key) && due(key),
      );
      const results = await Promise.all(fresh.map(([key, sandbox]) => start(sandbox, key)));
      return { linked: dialers.size, started: results.filter(Boolean).length, stopped };
    },
    linkedCount: () => dialers.size,
    close() {
      for (const key of [...dialers.keys()]) stop(key);
    },
  };
}

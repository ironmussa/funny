/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: registry
 * @domain layer: application
 *
 * Registry of sandbox providers. This is the ONLY module outside `providers/`
 * allowed to import a provider implementation. Adding a provider = register an
 * entry here + its adapter + template recipe; nothing else changes.
 */

import { err, ok, type Result } from 'neverthrow';
import type { z } from 'zod';

import type { SandboxCapabilities, SandboxProvider } from './contract.js';

export interface SandboxProviderEntry<Config = unknown> {
  id: string;
  displayName: string;
  /** Validates the non-secret connection config (e.g. a provider environment id). */
  configSchema: z.ZodType<Config>;
  /** Declared without a credential so the client can render options before connecting. */
  capabilities: SandboxCapabilities;
  create(input: { credential: string; config: Config }): SandboxProvider;
}

export type SandboxRegistryError =
  | { kind: 'unknown-provider'; providerId: string }
  | { kind: 'invalid-config'; providerId: string; message: string }
  | { kind: 'duplicate-provider'; providerId: string };

export interface SandboxProviderRegistry {
  list(): Array<Pick<SandboxProviderEntry, 'id' | 'displayName' | 'capabilities'>>;
  has(providerId: string): boolean;
  instantiate(input: {
    providerId: string;
    credential: string;
    config: unknown;
  }): Result<SandboxProvider, SandboxRegistryError>;
}

export function createSandboxProviderRegistry(
  entries: SandboxProviderEntry<any>[],
): Result<SandboxProviderRegistry, SandboxRegistryError> {
  const byId = new Map<string, SandboxProviderEntry<any>>();
  for (const entry of entries) {
    if (byId.has(entry.id)) return err({ kind: 'duplicate-provider', providerId: entry.id });
    byId.set(entry.id, entry);
  }

  return ok({
    list: () =>
      [...byId.values()].map(({ id, displayName, capabilities }) => ({
        id,
        displayName,
        capabilities,
      })),
    has: (providerId) => byId.has(providerId),
    instantiate: ({ providerId, credential, config }) => {
      const entry = byId.get(providerId);
      if (!entry) return err({ kind: 'unknown-provider', providerId });
      const parsed = entry.configSchema.safeParse(config ?? {});
      if (!parsed.success) {
        return err({ kind: 'invalid-config', providerId, message: parsed.error.message });
      }
      return ok(entry.create({ credential, config: parsed.data }));
    },
  });
}

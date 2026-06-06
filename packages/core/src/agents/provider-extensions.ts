/**
 * The `provider` kind of the funny extension system (runner-side). A provider
 * extension is a `package.json` whose `funny.provider` field points at a
 * declarative `funny.provider.json` manifest:
 *
 *   { "name": "funny-myagent", "funny": { "provider": "manifest.json" } }
 *
 * The runner scans its `<DATA_DIR>/extensions` dir, validates each manifest
 * against the frozen contract (`parseFunnyProviderFile` — declarative-only,
 * strict), binds it into a `GenericACPProcess` subclass, and registers it under
 * the existing `providerRegistry`. The full manifest (spawn + quirks) stays
 * runner-local; only the public face is advertised to the server (§3).
 *
 * Built on the kind-agnostic `@funny/core/extensions` core, the same machinery
 * the server uses for `client` (visualizer) extensions.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';

import type { ProviderManifest } from '@funny/shared/provider-manifest';
import { parseFunnyProviderFile } from '@funny/shared/provider-manifest-schema';
import { KNOWN_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';

import { createDebugLogger } from '../debug.js';
import { isInside, readPackageJson } from '../extensions/index.js';
import { GenericACPProcess } from './generic-acp.js';
import { registerProvider, type ProcessConstructor } from './process-factory.js';
import type { ClaudeProcessOptions } from './types.js';

const dlog = createDebugLogger('provider-extensions');

/** Provider ids funny ships built-in — an external manifest may not shadow them. */
const BUILTIN_PROVIDER_IDS = new Set<string>([
  ...KNOWN_ACP_PROVIDER_IDS,
  'claude',
  'deepagent',
  'llm-api',
  'external',
]);

/** Runner-local store of full external manifests (spawn + quirks stay here). */
const runnerManifests = new Map<string, ProviderManifest>();

/** Look up an external provider's full manifest (used by GenericACPProcess wiring). */
export function getRunnerManifest(id: string): ProviderManifest | undefined {
  return runnerManifests.get(id);
}

export interface LoadedProviderExtension {
  id: string;
  /** On-disk directory name. */
  dirName: string;
  manifest: ProviderManifest;
}

export interface LoadProviderExtensionsResult {
  loaded: LoadedProviderExtension[];
  errors: { dirName: string; error: string }[];
}

type DirParse =
  | null // not a provider extension — skip silently
  | { ok: true; manifest: ProviderManifest }
  | { ok: false; error: string };

/**
 * Parse one extension dir as a provider extension. Returns null when it is not
 * a provider extension at all (no `funny.provider`), a typed error when it is
 * but is malformed, or the validated manifest on success.
 */
function parseProviderExtensionDir(dir: string, dirName: string): DirParse {
  const pkgDir = join(dir, dirName);
  let pkg: Record<string, any> | null;
  try {
    if (!statSync(pkgDir).isDirectory()) return null;
    pkg = readPackageJson(pkgDir);
  } catch {
    return null;
  }
  const providerRef: unknown = pkg?.funny?.provider;
  if (typeof providerRef !== 'string' || !providerRef) return null; // not a provider ext

  // Resolve the referenced manifest file, guarding against symlink/traversal escape.
  let manifestAbs: string;
  try {
    const pkgDirReal = realpathSync(pkgDir);
    manifestAbs = realpathSync(resolve(pkgDirReal, providerRef));
    if (!isInside(pkgDirReal, manifestAbs) || manifestAbs === pkgDirReal) {
      return { ok: false, error: `funny.provider "${providerRef}" escapes the package` };
    }
    if (!statSync(manifestAbs).isFile()) {
      return { ok: false, error: `funny.provider "${providerRef}" is not a file` };
    }
  } catch {
    return { ok: false, error: `funny.provider "${providerRef}" was not found` };
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(manifestAbs, 'utf8'));
  } catch {
    return { ok: false, error: `manifest "${providerRef}" is not valid JSON` };
  }

  const parsed = parseFunnyProviderFile(json);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, manifest: parsed.file.manifest };
}

/** Build a one-arg process ctor that binds an external manifest into GenericACPProcess. */
function makeExternalProcessClass(manifest: ProviderManifest): ProcessConstructor {
  return class ExternalACPProcess extends GenericACPProcess {
    constructor(opts: ClaudeProcessOptions) {
      super(opts, manifest);
    }
  } as unknown as ProcessConstructor;
}

/**
 * Scan `dir` for provider extensions, validate each, and register the valid ones
 * against the runtime provider registry. Never throws — malformed manifests are
 * collected as typed errors and skipped so one bad extension never breaks the
 * others. Ids that collide with a built-in (or an already-loaded external)
 * provider are refused.
 */
export function loadProviderExtensions(dir: string): LoadProviderExtensionsResult {
  const loaded: LoadedProviderExtension[] = [];
  const errors: { dirName: string; error: string }[] = [];

  let names: string[];
  try {
    if (!existsSync(dir)) return { loaded, errors };
    names = readdirSync(dir);
  } catch {
    return { loaded, errors };
  }

  for (const dirName of names) {
    if (dirName.startsWith('.') || dirName.includes('/') || dirName.includes('\\')) continue;
    const parsed = parseProviderExtensionDir(dir, dirName);
    if (parsed === null) continue; // not a provider extension
    if (!parsed.ok) {
      dlog.warn('skipping malformed provider extension', { dirName, error: parsed.error });
      errors.push({ dirName, error: parsed.error });
      continue;
    }
    const { id } = parsed.manifest;
    if (BUILTIN_PROVIDER_IDS.has(id) || runnerManifests.has(id)) {
      const error = `provider id '${id}' collides with an existing provider`;
      dlog.warn('skipping colliding provider extension', { dirName, id });
      errors.push({ dirName, error });
      continue;
    }
    runnerManifests.set(id, parsed.manifest);
    registerProvider(id, makeExternalProcessClass(parsed.manifest));
    dlog.info('registered external provider', { id, dirName });
    loaded.push({ id, dirName, manifest: parsed.manifest });
  }

  return { loaded, errors };
}

/** Test/teardown helper: clear the runner-local manifest store. */
export function _clearRunnerManifests(): void {
  runnerManifests.clear();
}

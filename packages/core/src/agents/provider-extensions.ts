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
import type { AdvertisedProvider } from '@funny/shared/runner-protocol';

import { createDebugLogger } from '../debug.js';
import {
  installPackageFromGit,
  installPackageFromPath,
  isInside,
  readPackageJson,
  removeExtensionDir,
  type InstallResult,
  type KindHandler,
} from '../extensions/index.js';
import { GenericACPProcess } from './generic-acp.js';
import { registerProvider, unregisterProvider, type ProcessConstructor } from './process-factory.js';
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

/**
 * The PUBLIC FACE of every loaded external provider — the subset the server /
 * client need (id, label, model strategy, attachment limits, auth mode). The
 * spawn command + quirks are deliberately excluded; they stay runner-local.
 * The runner advertises this to the server on register + heartbeat (§3).
 */
export function getAdvertisedProviders(): AdvertisedProvider[] {
  const out: AdvertisedProvider[] = [];
  for (const m of runnerManifests.values()) {
    const models: AdvertisedProvider['models'] =
      m.models.kind === 'static'
        ? { kind: 'static', defaultModel: m.models.defaultModel, entries: Object.values(m.models.entries) }
        : { kind: 'dynamic', defaultModel: m.models.defaultModel };
    out.push({
      id: m.id,
      label: m.label,
      models,
      attachmentLimits: m.attachmentLimits,
      auth: { mode: m.auth.mode, providerKeyId: m.auth.providerKeyId },
    });
  }
  return out;
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
 * Validate + register ONE provider extension directory against the runtime
 * provider registry. Returns the loaded record on success, a typed error if it
 * is a malformed/colliding provider extension, or null if the directory is not
 * a provider extension at all. Never throws.
 *
 * The atomic unit behind both the startup scan ({@link loadProviderExtensions})
 * and the live UI install (provider-install-ui): registering a single newly
 * dropped/installed extension with no full rescan or restart.
 */
export function registerProviderExtension(
  dir: string,
  dirName: string,
): { ok: true; loaded: LoadedProviderExtension } | { ok: false; error: string } | null {
  if (dirName.startsWith('.') || dirName.includes('/') || dirName.includes('\\')) return null;
  const parsed = parseProviderExtensionDir(dir, dirName);
  if (parsed === null) return null; // not a provider extension
  if (!parsed.ok) {
    dlog.warn('skipping malformed provider extension', { dirName, error: parsed.error });
    return { ok: false, error: parsed.error };
  }
  const { id } = parsed.manifest;
  if (BUILTIN_PROVIDER_IDS.has(id) || runnerManifests.has(id)) {
    dlog.warn('skipping colliding provider extension', { dirName, id });
    return { ok: false, error: `provider id '${id}' collides with an existing provider` };
  }
  runnerManifests.set(id, parsed.manifest);
  registerProvider(id, makeExternalProcessClass(parsed.manifest));
  dlog.info('registered external provider', { id, dirName });
  return { ok: true, loaded: { id, dirName, manifest: parsed.manifest } };
}

/**
 * Un-register a previously loaded external provider (live, no restart). Returns
 * true if it was registered. Built-in providers are never removed here.
 */
export function unregisterProviderExtension(id: string): boolean {
  if (BUILTIN_PROVIDER_IDS.has(id) || !runnerManifests.has(id)) return false;
  runnerManifests.delete(id);
  unregisterProvider(id);
  dlog.info('unregistered external provider', { id });
  return true;
}

/**
 * Scan `dir` for provider extensions and register the valid ones. Never throws —
 * malformed/colliding manifests are collected as typed errors and skipped so one
 * bad extension never breaks the others.
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
    const res = registerProviderExtension(dir, dirName);
    if (res === null) continue;
    if (res.ok) loaded.push(res.loaded);
    else errors.push({ dirName, error: res.error });
  }

  return { loaded, errors };
}

// ── Install / remove (the UI-driven path; provider-install-ui §2) ───────────

/**
 * The `provider` kind handler for the generic install pipeline: validate a
 * SOURCE package has a `funny.provider` pointing at a present file, and read an
 * installed dir back into a {@link LoadedProviderExtension}. Full schema
 * validation + registration happen in `registerProviderExtension`.
 */
const providerKindHandler: KindHandler<LoadedProviderExtension> = {
  validateSource(pkg, src) {
    const ref = pkg?.funny?.provider;
    if (typeof ref !== 'string' || !ref) {
      return 'package.json is missing the funny.provider field';
    }
    try {
      const abs = resolve(src, ref);
      if (!isInside(src, abs) || !existsSync(abs) || !statSync(abs).isFile()) {
        return `funny.provider entry "${ref}" was not found`;
      }
    } catch {
      return `funny.provider entry "${ref}" was not found`;
    }
    return null;
  },
  read(dir, dirName) {
    const parsed = parseProviderExtensionDir(dir, dirName);
    return parsed && parsed.ok ? { id: parsed.manifest.id, dirName, manifest: parsed.manifest } : null;
  },
};

export type InstallProviderResult =
  | { ok: true; loaded: LoadedProviderExtension }
  | { ok: false; error: string };

/** Copy-installed → validate + register; on registration refusal, roll back the copy. */
function finishInstall(
  extDir: string,
  res: InstallResult<LoadedProviderExtension>,
): InstallProviderResult {
  if (!res.ok) return { ok: false, error: res.error };
  const reg = registerProviderExtension(extDir, res.value.dirName);
  if (reg === null) return { ok: false, error: 'installed package is not a provider extension' };
  if (!reg.ok) {
    removeExtensionDir(res.value.dirName, extDir); // roll back a colliding/invalid install
    return { ok: false, error: reg.error };
  }
  return { ok: true, loaded: reg.loaded };
}

/** Install a provider extension from a local pre-built package dir into `extDir`, then register it. */
export function installProviderExtensionFromPath(
  srcPath: string,
  extDir: string,
): InstallProviderResult {
  return finishInstall(extDir, installPackageFromPath(srcPath, extDir, providerKindHandler));
}

/** Install a provider extension from a git spec into `extDir`, then register it. */
export async function installProviderExtensionFromGit(
  spec: string,
  opts: { ref?: string; subdir?: string },
  extDir: string,
): Promise<InstallProviderResult> {
  return finishInstall(
    extDir,
    await installPackageFromGit(spec, { ...opts, dir: extDir }, providerKindHandler),
  );
}

/** Remove + de-register an installed provider extension by its on-disk dir name. */
export function removeProviderExtension(
  extDir: string,
  dirName: string,
): { ok: true; id: string | null } | { ok: false; error: string } {
  const parsed = parseProviderExtensionDir(extDir, dirName);
  const id = parsed && parsed.ok ? parsed.manifest.id : null;
  if (id) unregisterProviderExtension(id);
  const rm = removeExtensionDir(dirName, extDir);
  if (!rm.ok) return { ok: false, error: rm.error };
  return { ok: true, id };
}

/**
 * Remove + de-register an installed provider extension by its provider id (the
 * handle the client has from the advertised list). Resolves the on-disk dir by
 * matching the parsed manifest id.
 */
export function removeProviderExtensionById(
  extDir: string,
  id: string,
): { ok: true } | { ok: false; error: string } {
  let names: string[];
  try {
    names = readdirSync(extDir);
  } catch {
    names = [];
  }
  for (const dirName of names) {
    const parsed = parseProviderExtensionDir(extDir, dirName);
    if (parsed && parsed.ok && parsed.manifest.id === id) {
      const res = removeProviderExtension(extDir, dirName);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
  }
  // Not found on disk — de-register if it is still registered, else report.
  return unregisterProviderExtension(id)
    ? { ok: true }
    : { ok: false, error: `provider '${id}' not found` };
}

/** Test/teardown helper: clear the runner-local manifest store. */
export function _clearRunnerManifests(): void {
  runnerManifests.clear();
}

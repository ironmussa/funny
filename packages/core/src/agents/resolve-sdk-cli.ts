/**
 * Resolves the path to the Claude Agent SDK's CLI executable.
 *
 * Two SDK packaging layouts must be handled:
 *
 *  - Legacy (≤0.2.111): JS entry at @anthropic-ai/claude-agent-sdk/cli.js
 *    — needs a JS runtime (`executable: 'node'`) to run.
 *  - Current (≥~0.2.130): native binary at
 *    @anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe]
 *    — exec'd directly; the `executable` option is irrelevant.
 *
 * When code is bundled (e.g. via Bun.build into dist/index.js), the SDK's
 * default resolution — dirname(import.meta.url)/../cli.js — points to the
 * bundle's directory instead of the SDK package directory, so we resolve
 * explicitly via createRequire and a cwd walk-up.
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

export type SDKCliKind = 'js' | 'native';
export interface ResolvedSDKCli {
  path: string;
  kind: SDKCliKind;
}

let cached: ResolvedSDKCli | null = null;

function nativePackageNames(): string[] {
  const platform = process.platform;
  const arch = process.arch;
  const names: string[] = [];
  if (platform === 'linux') {
    names.push(`@anthropic-ai/claude-agent-sdk-linux-${arch}`);
    names.push(`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`);
  } else if (platform === 'darwin') {
    names.push(`@anthropic-ai/claude-agent-sdk-darwin-${arch}`);
  } else if (platform === 'win32') {
    names.push(`@anthropic-ai/claude-agent-sdk-win32-${arch}`);
  }
  return names;
}

function nativeBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function tryNativeCandidate(dir: string): ResolvedSDKCli | null {
  const binName = nativeBinaryName();
  for (const pkg of nativePackageNames()) {
    const candidate = join(dir, 'node_modules', pkg, binName);
    if (existsSync(candidate)) return { path: candidate, kind: 'native' };
  }
  return null;
}

export function resolveSDKCli(): ResolvedSDKCli {
  if (cached) return cached;

  // Strategy 1: createRequire from this module — locate the SDK package, then
  // try the legacy cli.js next to it, then the platform-specific native binary
  // resolved through the same require context (so workspace hoisting works).
  try {
    const req = createRequire(import.meta.url);
    const sdkPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkDir = dirname(sdkPkgJson);

    const legacy = join(sdkDir, 'cli.js');
    if (existsSync(legacy)) {
      cached = { path: legacy, kind: 'js' };
      return cached;
    }

    // The platform-specific package is the SDK's own optionalDependency, so
    // it's typically NOT hoisted to top-level node_modules. Resolve it from
    // the SDK's require context (same trick the SDK uses internally) so we
    // see its private node_modules tree.
    const sdkReq = createRequire(sdkPkgJson);
    const binName = nativeBinaryName();
    for (const pkg of nativePackageNames()) {
      try {
        const nativePkgJson = sdkReq.resolve(`${pkg}/package.json`);
        const candidate = join(dirname(nativePkgJson), binName);
        if (existsSync(candidate)) {
          cached = { path: candidate, kind: 'native' };
          return cached;
        }
      } catch {
        // Platform package not installed (wrong OS/arch) — try next.
      }
    }

    // Final fallback: probe the SDK's nested node_modules directly, in case
    // the package manager set up the layout without a resolvable package.json
    // entry on its module graph.
    for (const pkg of nativePackageNames()) {
      const candidate = join(sdkDir, '..', '..', pkg, binName);
      if (existsSync(candidate)) {
        cached = { path: candidate, kind: 'native' };
        return cached;
      }
    }
  } catch {
    // createRequire may fail in bundled contexts — fall through.
  }

  // Strategy 2: walk up from cwd to find node_modules and try both layouts.
  let dir = process.cwd();
  while (dir) {
    const legacy = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
    if (existsSync(legacy)) {
      cached = { path: legacy, kind: 'js' };
      return cached;
    }
    const native = tryNativeCandidate(dir);
    if (native) {
      cached = native;
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    'Could not find the Claude Agent SDK CLI (legacy cli.js or platform-specific ' +
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude). ` +
      'Is @anthropic-ai/claude-agent-sdk installed?',
  );
}

/**
 * Back-compat: returns just the resolved path. Prefer {@link resolveSDKCli}
 * at call sites that also set the `executable` option, so they can drop
 * `executable: 'node'` when the resolved binary is native.
 */
export function resolveSDKCliPath(): string {
  return resolveSDKCli().path;
}

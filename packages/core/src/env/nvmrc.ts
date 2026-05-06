/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: utility
 * @domain layer: domain
 *
 * Detects a Node.js version requirement from `.nvmrc` and locates a matching
 * installed version under nvm/fnm directories. Returns env-var mutations to
 * put that Node on PATH — same idea as `nvm use` but without sourcing the
 * nvm shell function.
 *
 * Limitations: only exact version strings are supported (e.g. "20.11.0" or
 * "v20.11.0"). Aliases like "lts/iron", "node", or "--lts" are skipped
 * because resolving them requires querying nvm's alias table.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { delimiter, resolve } from 'path';

const IS_WINDOWS = process.platform === 'win32';
const NODE_BIN = IS_WINDOWS ? 'node.exe' : 'node';
const EXACT_VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;

export interface NodeVersionResolution {
  /** Resolved version (without leading "v"). */
  version: string;
  /** Absolute path to the bin directory containing the node binary. */
  binPath: string;
  /** Env-var mutations to merge into the spawn env. */
  env: {
    PATH: string;
  };
}

function readNvmrc(cwd: string): string | null {
  const nvmrcPath = resolve(cwd, '.nvmrc');
  if (!existsSync(nvmrcPath)) return null;
  try {
    const raw = readFileSync(nvmrcPath, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Candidate directories where node version managers install node releases. */
function candidateInstallDirs(parentEnv: Record<string, string | undefined>): string[] {
  const home = parentEnv.HOME ?? homedir();
  const dirs: string[] = [];

  const nvmDir = parentEnv.NVM_DIR ?? resolve(home, '.nvm');
  dirs.push(resolve(nvmDir, 'versions/node'));

  const fnmDir = parentEnv.FNM_DIR ?? resolve(home, '.fnm');
  dirs.push(resolve(fnmDir, 'node-versions'));

  const fnmMultishell = parentEnv.FNM_MULTISHELL_PATH;
  if (fnmMultishell) dirs.push(fnmMultishell);

  return dirs.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function findInstalledVersion(version: string, installDirs: string[]): string | null {
  const targets = [`v${version}`, version];

  for (const dir of installDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const target of targets) {
      if (!entries.includes(target)) continue;

      // nvm layout: <dir>/v20.11.0/bin/node
      const nvmBin = resolve(dir, target, 'bin', NODE_BIN);
      if (existsSync(nvmBin)) return resolve(dir, target, 'bin');

      // fnm layout: <dir>/v20.11.0/installation/bin/node
      const fnmBin = resolve(dir, target, 'installation', 'bin', NODE_BIN);
      if (existsSync(fnmBin)) return resolve(dir, target, 'installation', 'bin');
    }
  }

  return null;
}

/**
 * Detect a Node version pinned by `.nvmrc` and locate a matching installation.
 * Returns env mutations to put that Node on PATH, or `null` if the file is
 * missing, the version is an unsupported alias, or no matching install exists.
 */
export function resolveNodeVersion(
  cwd: string,
  parentEnv: Record<string, string | undefined> = process.env,
): NodeVersionResolution | null {
  const raw = readNvmrc(cwd);
  if (!raw) return null;

  const match = raw.match(EXACT_VERSION_RE);
  if (!match) return null; // Aliases like lts/iron, node, --lts not supported

  const version = match[1];
  const binPath = findInstalledVersion(version, candidateInstallDirs(parentEnv));
  if (!binPath) return null;

  const currentPath = parentEnv.PATH ?? parentEnv.Path ?? '';
  const newPath = currentPath ? `${binPath}${delimiter}${currentPath}` : binPath;

  return {
    version,
    binPath,
    env: { PATH: newPath },
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { WeaveStatus } from '@funny/shared';
import { internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { execute, gitRead, gitWrite, type EnvOverrides } from './process.js';

const WEAVE_DRIVER_NAME = 'weave';
const WEAVE_DRIVER_CMD = 'weave-driver %O %A %B %L %P';
const WEAVE_EXTENSIONS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.py',
  '*.go',
  '*.rs',
  '*.java',
  '*.c',
  '*.cpp',
  '*.h',
  '*.rb',
  '*.cs',
  '*.php',
  '*.swift',
  '*.json',
  '*.yaml',
  '*.yml',
  '*.toml',
  '*.md',
];

/** Check if weave-driver is available on PATH. */
async function isWeaveInstalled(): Promise<boolean> {
  try {
    const result = await execute('which', ['weave-driver'], { reject: false, skipPool: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Check if the merge.weave.driver is configured in local git config. */
async function isDriverConfigured(cwd: string): Promise<boolean> {
  try {
    const result = await gitRead(
      ['config', '--local', '--get', `merge.${WEAVE_DRIVER_NAME}.driver`],
      {
        cwd,
        reject: false,
      },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if .git/info/attributes contains merge=weave lines. */
function isAttributesConfigured(cwd: string): boolean {
  const attributesPath = join(cwd, '.git', 'info', 'attributes');
  if (!existsSync(attributesPath)) return false;
  try {
    const content = readFileSync(attributesPath, 'utf-8');
    return content.includes(`merge=${WEAVE_DRIVER_NAME}`);
  } catch {
    return false;
  }
}

/** Derive the overall status from the three checks. */
function deriveStatus(
  driverInstalled: boolean,
  driverConfigured: boolean,
  attributesConfigured: boolean,
): WeaveStatus['status'] {
  if (!driverInstalled) return 'not-installed';
  if (!driverConfigured || !attributesConfigured) return 'unconfigured';
  return 'active';
}

/** Get the current Weave configuration status for a project. */
export function getWeaveStatus(projectPath: string): ResultAsync<WeaveStatus, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const driverInstalled = await isWeaveInstalled();
      const driverConfigured = await isDriverConfigured(projectPath);
      const attributesConfigured = isAttributesConfigured(projectPath);
      const status = deriveStatus(driverInstalled, driverConfigured, attributesConfigured);
      return { driverInstalled, driverConfigured, attributesConfigured, status };
    })(),
    (error) => internal(`Failed to check Weave status: ${String(error)}`),
  );
}

/**
 * Ensure Weave is configured as the git merge driver for a project.
 * Idempotent — safe to call multiple times. Returns the resulting status.
 * If weave-driver is not installed, returns not-installed status without error.
 */
export function ensureWeaveConfigured(projectPath: string): ResultAsync<WeaveStatus, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const driverInstalled = await isWeaveInstalled();
      if (!driverInstalled) {
        return {
          driverInstalled: false,
          driverConfigured: false,
          attributesConfigured: false,
          status: 'not-installed' as const,
        };
      }

      // Configure git merge driver (local config only)
      await gitWrite(
        ['config', '--local', `merge.${WEAVE_DRIVER_NAME}.name`, 'Weave semantic merge driver'],
        { cwd: projectPath, reject: false },
      );
      await gitWrite(['config', '--local', `merge.${WEAVE_DRIVER_NAME}.driver`, WEAVE_DRIVER_CMD], {
        cwd: projectPath,
        reject: false,
      });

      // Ensure .git/info/ directory exists
      const infoDir = join(projectPath, '.git', 'info');
      if (!existsSync(infoDir)) {
        mkdirSync(infoDir, { recursive: true });
      }

      // Read existing attributes and append missing lines
      const attributesPath = join(infoDir, 'attributes');
      let existing = '';
      if (existsSync(attributesPath)) {
        existing = readFileSync(attributesPath, 'utf-8');
      }

      const linesToAdd: string[] = [];
      for (const ext of WEAVE_EXTENSIONS) {
        const line = `${ext} merge=${WEAVE_DRIVER_NAME}`;
        if (!existing.includes(line)) {
          linesToAdd.push(line);
        }
      }

      if (linesToAdd.length > 0) {
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        const newContent = existing + separator + linesToAdd.join('\n') + '\n';
        writeFileSync(attributesPath, newContent, 'utf-8');
      }

      return {
        driverInstalled: true,
        driverConfigured: true,
        attributesConfigured: true,
        status: 'active' as const,
      };
    })(),
    (error) => internal(`Failed to configure Weave: ${String(error)}`),
  );
}

/**
 * Git configuration for a factory run's processes, carried in their
 * environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`)
 * so nothing is written to the repository: a worktree's `.git/config` and
 * `info/attributes` belong to the common git dir, which the user's own checkout
 * shares. `rerere` records and replays conflict resolutions; when weave-driver
 * is installed it is the merge driver for the languages it handles, through an
 * attributes file funny owns in `dir`.
 */
export function factoryGitConfigEnv(
  dir: string,
): ResultAsync<{ env: Record<string, string>; weave: boolean }, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const entries: Array<[string, string]> = [
        ['rerere.enabled', 'true'],
        ['rerere.autoUpdate', 'true'],
      ];
      const weave = await isWeaveInstalled();
      if (weave) {
        mkdirSync(dir, { recursive: true });
        const attributesFile = join(dir, 'weave.gitattributes');
        const lines = WEAVE_EXTENSIONS.map((ext) => `${ext} merge=${WEAVE_DRIVER_NAME}`);
        writeFileSync(attributesFile, `${lines.join('\n')}\n`);
        entries.push(
          [`merge.${WEAVE_DRIVER_NAME}.name`, 'Weave semantic merge driver'],
          [`merge.${WEAVE_DRIVER_NAME}.driver`, WEAVE_DRIVER_CMD],
          ['core.attributesFile', attributesFile],
        );
      }
      const env: EnvOverrides = { GIT_CONFIG_COUNT: String(entries.length) };
      entries.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
      return { env, weave };
    })(),
    (error) => internal(`Failed to prepare the factory git configuration: ${String(error)}`),
  );
}

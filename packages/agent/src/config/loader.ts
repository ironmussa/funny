/**
 * Config loader — reads `.pipeline/config.yaml`, resolves env vars, validates.
 *
 * If the config file doesn't exist, returns all defaults.
 */

import { join } from 'path';
import { parse as parseYAML } from 'yaml';
import { execSync } from 'child_process';
import { PipelineServiceConfigSchema, type PipelineServiceConfig } from './schema.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Recursively resolve `${VAR_NAME}` patterns in config values.
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)]),
    );
  }
  return obj;
}

/**
 * Detect the default branch of a git repository.
 *
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first (works when
 * the remote HEAD is set), then falls back to checking if common branch
 * names (`main`, `master`) exist locally.
 */
function detectDefaultBranch(projectPath: string): string | null {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // ref is like "refs/remotes/origin/main" — extract the last segment
    const branch = ref.split('/').pop();
    if (branch) return branch;
  } catch {
    // origin/HEAD not set — try common branch names
  }

  for (const candidate of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return candidate;
    } catch {
      // branch doesn't exist, try next
    }
  }

  return null;
}

/**
 * Load and validate the pipeline service configuration.
 *
 * Reads `.pipeline/config.yaml` if present, otherwise uses all defaults.
 * Environment variables in `${VAR}` format are resolved before validation.
 *
 * If `branch.main` is not explicitly set in the YAML, the loader auto-detects
 * the default branch from the git repository.
 */
export async function loadConfig(projectPath: string): Promise<PipelineServiceConfig> {
  const configPath = join(projectPath, '.pipeline', 'config.yaml');
  const file = Bun.file(configPath);

  let rawConfig: Record<string, unknown> = {};

  if (await file.exists()) {
    try {
      const text = await file.text();
      const parsed = parseYAML(text);
      if (parsed && typeof parsed === 'object') {
        rawConfig = resolveEnvVars(parsed) as Record<string, unknown>;
      }
      logger.info({ configPath }, 'Loaded pipeline config from YAML');
    } catch (err: any) {
      logger.error({ err: err.message, configPath }, 'Failed to parse config.yaml, using defaults');
    }
  } else {
    logger.info('No .pipeline/config.yaml found, using defaults');
  }

  // Check if branch.main was explicitly provided in config
  const branchConfig = rawConfig.branch as Record<string, unknown> | undefined;
  const hasExplicitMain = branchConfig?.main !== undefined;

  // Validate and apply defaults via Zod
  const result = PipelineServiceConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    logger.error({ errors: result.error.issues }, 'Config validation failed, using defaults');
    return PipelineServiceConfigSchema.parse({});
  }

  const config = result.data;

  // Auto-detect default branch if not explicitly configured
  if (!hasExplicitMain) {
    const detected = detectDefaultBranch(projectPath);
    if (detected && detected !== config.branch.main) {
      logger.info({ detected, previous: config.branch.main }, 'Auto-detected default branch');
      config.branch.main = detected;
    }
  }

  return config;
}

/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Filesystem
 *
 * Manages `.funny.json` project configuration (envFiles, portGroups, postCreate).
 * Merges updates with existing file content to preserve unknown fields.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FunnyProjectConfig } from '@funny/shared';
import { funnyProjectConfigSchema } from '@funny/shared/funny-config-schema';
import { parseStoredJson } from '@funny/shared/json-validation';

const CONFIG_FILENAME = '.funny.json';

/** Read `.funny.json` from a project directory */
export function getConfig(projectPath: string): FunnyProjectConfig {
  const filePath = join(projectPath, CONFIG_FILENAME);
  if (!existsSync(filePath)) return {};
  const parsed = parseStoredJson(
    funnyProjectConfigSchema,
    readFileSync(filePath, 'utf-8'),
    filePath,
  );
  return parsed.ok ? parsed.value : {};
}

/** Update `.funny.json` — merges with existing content to preserve unknown fields */
export function updateConfig(projectPath: string, config: FunnyProjectConfig): void {
  const filePath = join(projectPath, CONFIG_FILENAME);

  // Read existing file to preserve unknown fields
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const parsed = parseStoredJson(
      funnyProjectConfigSchema,
      readFileSync(filePath, 'utf-8'),
      filePath,
    );
    if (parsed.ok) existing = parsed.value;
  }

  // Merge known fields
  if (config.envFiles !== undefined) existing.envFiles = config.envFiles;
  if (config.portGroups !== undefined) existing.portGroups = config.portGroups;
  if (config.postCreate !== undefined) existing.postCreate = config.postCreate;

  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

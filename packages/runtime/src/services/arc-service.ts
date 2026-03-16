/**
 * Arc artifact management — filesystem operations for creating arc directories
 * and reading arc artifact files from the project repository.
 */

import { readdir, readFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type { ArcArtifacts } from '@funny/shared';
import { Result, ok, err } from 'neverthrow';

const ARC_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ARC_NAME_MAX_LENGTH = 100;

/**
 * Validate that an arc name is kebab-case: lowercase letters, numbers, and hyphens.
 * No leading/trailing hyphens. Max 100 characters.
 */
export function validateArcName(name: string): Result<string, string> {
  if (!name || name.length === 0) {
    return err('Arc name is required');
  }
  if (name.length > ARC_NAME_MAX_LENGTH) {
    return err(`Arc name must be ${ARC_NAME_MAX_LENGTH} characters or fewer`);
  }
  if (!ARC_NAME_REGEX.test(name)) {
    return err('Arc name must be kebab-case (lowercase letters, numbers, and hyphens only)');
  }
  return ok(name);
}

/**
 * Create the `arcs/<name>/` directory at the resolved project path.
 * Creates the parent `arcs/` directory lazily if it doesn't exist.
 */
export async function createArcDirectory(
  projectPath: string,
  name: string,
): Promise<Result<string, string>> {
  const arcDir = join(projectPath, 'arcs', name);
  try {
    await mkdir(arcDir, { recursive: true });
    return ok(arcDir);
  } catch (e) {
    return err(`Failed to create arc directory: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Read arc artifact files from `arcs/<name>/` in the project directory.
 * Returns content for each file that exists; missing files are omitted.
 */
export async function readArcArtifacts(projectPath: string, name: string): Promise<ArcArtifacts> {
  const arcDir = join(projectPath, 'arcs', name);
  const artifacts: ArcArtifacts = {};

  // Read top-level artifact files
  for (const [key, filename] of [
    ['proposal', 'proposal.md'],
    ['design', 'design.md'],
    ['tasks', 'tasks.md'],
  ] as const) {
    try {
      artifacts[key] = await readFile(join(arcDir, filename), 'utf-8');
    } catch {
      // File doesn't exist — skip
    }
  }

  // Read specs subdirectories
  const specsDir = join(arcDir, 'specs');
  try {
    const entries = await readdir(specsDir, { withFileTypes: true });
    const specs: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const specContent = await readFile(join(specsDir, entry.name, 'spec.md'), 'utf-8');
          specs[entry.name] = specContent;
        } catch {
          // spec.md doesn't exist in this subdirectory — skip
        }
      }
    }
    if (Object.keys(specs).length > 0) {
      artifacts.specs = specs;
    }
  } catch {
    // specs/ directory doesn't exist — skip
  }

  return artifacts;
}

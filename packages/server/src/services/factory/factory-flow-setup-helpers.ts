/**
 * Small pure helpers for the factory flow setup (openspec `factory-flow-bootstrap`).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  listAgentSteps,
  loadWorkflowCatalog,
  normalizePromptPath,
  parseWorkflowYaml,
} from '@funny/workflows';

import type { StoredSetupPromptFile } from './factory-flow-setup-types.js';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function flowFilePath(flowName: string): string {
  return `.funny/workflows/${flowName}.yaml`;
}

/** Collect unchanged copies of any built-in `prompt_file`s referenced by a built-in flow. */
export async function collectBuiltInPrompts(
  flowName: string,
  yaml: string,
  defaultsDir?: string,
): Promise<StoredSetupPromptFile[]> {
  const parsed = parseWorkflowYaml(yaml, `${flowName}.yaml`);
  if (!parsed.ok) return [];
  const { workflows } = await loadWorkflowCatalog({ defaultsDir });
  const entry = workflows.get(flowName);
  if (!entry) return [];
  const baseDir = dirname(entry.filePath);

  const seen = new Set<string>();
  const prompts: StoredSetupPromptFile[] = [];
  for (const { action } of listAgentSteps(parsed.workflow)) {
    if (!action.prompt_file) continue;
    const norm = normalizePromptPath(action.prompt_file);
    if ('error' in norm || seen.has(norm.path)) continue;
    seen.add(norm.path);
    try {
      const content = await readFile(join(baseDir, norm.path), 'utf8');
      prompts.push({ path: `.funny/workflows/${norm.path}`, content });
    } catch {
      // Missing prompt file would already have been caught by `loadFactoryFlow`.
    }
  }
  return prompts;
}

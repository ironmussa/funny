import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatParseError, parseWorkflowYaml } from './parse.js';
import type { ParsedWorkflow } from './schema.js';

export type WorkflowSource = 'built-in' | 'user';

export interface WorkflowCatalogEntry {
  name: string;
  source: WorkflowSource;
  filePath: string;
  workflow: ParsedWorkflow;
  yaml: string;
}

export interface WorkflowCatalogLoadOptions {
  repoRoot?: string;
  defaultsDir?: string;
}

export interface WorkflowCatalogLoadResult {
  workflows: Map<string, WorkflowCatalogEntry>;
  warnings: string[];
}

export async function loadWorkflowCatalog(
  opts: WorkflowCatalogLoadOptions = {},
): Promise<WorkflowCatalogLoadResult> {
  const warnings: string[] = [];
  const defaultsDir = opts.defaultsDir ?? builtInWorkflowsDir();
  const userDir = opts.repoRoot ? path.join(opts.repoRoot, '.funny', 'workflows') : undefined;

  const [builtInFiles, userFiles] = await Promise.all([
    listYamlFiles(defaultsDir, true),
    userDir ? listYamlFiles(userDir, false) : Promise.resolve([]),
  ]);

  const workflows = new Map<string, WorkflowCatalogEntry>();
  await mergeLayer(workflows, builtInFiles, 'built-in', warnings, true);
  await mergeLayer(workflows, userFiles, 'user', warnings, false);

  return { workflows, warnings };
}

export function builtInWorkflowsDir(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), '..', 'defaults');
}

async function mergeLayer(
  acc: Map<string, WorkflowCatalogEntry>,
  files: string[],
  source: WorkflowSource,
  warnings: string[],
  strict: boolean,
): Promise<void> {
  for (const filePath of files) {
    let yaml: string;
    try {
      yaml = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const note = `Failed to read ${source} workflow ${filePath}: ${message}`;
      if (strict) throw new Error(note, { cause: err });
      warnings.push(note);
      continue;
    }

    const result = parseWorkflowYaml(yaml, filePath);
    if (!result.ok) {
      const note = formatParseError(result.error);
      if (strict) throw new Error(note);
      warnings.push(`Skipped ${source} workflow at ${filePath}: ${note}`);
      continue;
    }

    const existing = acc.get(result.workflow.name);
    if (!existing || sourceRank(source) > sourceRank(existing.source)) {
      acc.set(result.workflow.name, {
        name: result.workflow.name,
        source,
        filePath,
        workflow: result.workflow,
        yaml,
      });
    }
  }
}

function sourceRank(source: WorkflowSource): number {
  return source === 'user' ? 1 : 0;
}

async function listYamlFiles(dir: string, required: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' && !required) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
    .map((e) => path.join(dir, e.name))
    .sort();
}

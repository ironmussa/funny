/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: loader
 * @domain layer: infrastructure
 * @domain depends: yaml-compiler, agent-registry
 *
 * YAML workflow loader.
 *
 * Reads YAML workflow definitions from disk in two layers:
 *
 *   1. Built-in defaults from `@funny/workflows/defaults/*.yaml`
 *      (shipped with funny — what every install gets out of the box).
 *
 *   2. User overrides at `<repoRoot>/.funny/workflows/*.yaml`
 *      (per-repo customization). When a user file declares the same
 *      `name:` as a built-in, the user file wins.
 *
 * Sub-pipeline references (`pipeline: { name: foo }`) are resolved
 * against the merged set of workflows, so `code-quality` can call
 * `commit` regardless of which layer each comes from.
 */

import type { PipelineDefinition } from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';
import {
  loadWorkflowCatalog,
  type ParsedWorkflow,
  type WorkflowCatalogEntry,
} from '@funny/workflows';

import { log } from '../lib/logger.js';
import {
  compileYamlPipeline,
  YamlCompileError,
  type AgentResolver,
  type YamlPipelineContext,
} from './yaml-compiler.js';

// ── Public API ──────────────────────────────────────────────

export interface LoadOptions {
  /** Repository root. Used to find `.funny/workflows/`. */
  repoRoot?: string;
  /** Resolves named agents (`agent: reviewer` → AgentDefinition). */
  resolveAgent: AgentResolver;
  /** Override path to the built-in defaults dir (mostly for testing). */
  defaultsDir?: string;
}

export interface LoadedPipeline {
  /** Pipeline name (from the YAML). */
  name: string;
  /** Layer this pipeline came from — useful for debugging. */
  source: 'built-in' | 'user';
  /** Absolute path to the source YAML file. */
  filePath: string;
  /** Compiled, runnable pipeline definition. */
  definition: PipelineDefinition<YamlPipelineContext>;
  /** The parsed (validated) shape, kept for introspection. */
  parsed: ParsedWorkflow;
}

export interface LoadResult {
  /** All pipelines, keyed by name. */
  pipelines: Map<string, LoadedPipeline>;
  /** Non-fatal warnings (e.g. a malformed user file was skipped). */
  warnings: string[];
}

/**
 * Load and compile every YAML workflow visible from the given repo.
 *
 * Throws on:
 *   - Syntax errors in built-in YAMLs (these are bugs in funny — bail loud).
 *   - Compile errors (cycles, etc.) in built-ins.
 *
 * Logs warnings (and continues) on:
 *   - Malformed user YAMLs (their authors should fix them, but the
 *     rest of the system shouldn't fail because of one bad override).
 */
export async function loadPipelines(opts: LoadOptions): Promise<LoadResult> {
  const catalog = await loadWorkflowCatalog({
    repoRoot: opts.repoRoot,
    defaultsDir: opts.defaultsDir,
  });
  const warnings = [...catalog.warnings];

  // Compile in two passes so `pipeline: { name: ... }` references resolve
  // regardless of declaration order. First pass: compile every pipeline
  // with an EMPTY subPipelines registry (sub-references resolve at run
  // time via the registry that we hand out below). Second pass: build the
  // final registry and rebind.
  //
  // Simpler approach used here: compile in dependency order (referenced
  // pipelines first). If A references B, B must be compiled first. We
  // sort by topological order over `pipeline:` references.
  const ordered = topoSortByPipelineRefs(catalog.workflows, warnings);

  const compiled = new Map<string, LoadedPipeline>();
  for (const entry of ordered) {
    try {
      const subPipelines: Record<string, PipelineDefinition<YamlPipelineContext>> = {};
      for (const ref of collectPipelineRefs(entry.workflow)) {
        const sub = compiled.get(ref);
        if (sub) subPipelines[ref] = sub.definition;
      }
      const definition = compileYamlPipeline(entry.workflow, {
        resolveAgent: opts.resolveAgent,
        subPipelines,
      });
      compiled.set(entry.workflow.name, {
        name: entry.workflow.name,
        source: entry.source,
        filePath: entry.filePath,
        definition,
        parsed: entry.workflow,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (entry.source === 'built-in') {
        // Bug in funny — loud failure.
        throw err instanceof YamlCompileError ? err : new Error(message);
      }
      warnings.push(`Skipped ${entry.source} workflow at ${entry.filePath}: ${message}`);
      log.warn('Workflow compile failed (non-fatal layer)', {
        namespace: 'yaml-loader',
        filePath: entry.filePath,
        layer: entry.source,
        error: message,
      });
    }
  }

  return { pipelines: compiled, warnings };
}

/**
 * Convenience helper for the common case: load everything and return the
 * pipeline definition by name. Throws if the name is missing.
 */
export async function getPipelineByName(
  name: string,
  opts: LoadOptions,
): Promise<PipelineDefinition<YamlPipelineContext>> {
  const { pipelines } = await loadPipelines(opts);
  const found = pipelines.get(name);
  if (!found) {
    throw new Error(
      `Pipeline "${name}" not found. Loaded: ${[...pipelines.keys()].join(', ') || '(none)'}`,
    );
  }
  return found.definition;
}

// ── Internals ───────────────────────────────────────────────

function collectPipelineRefs(p: ParsedWorkflow): string[] {
  const refs: string[] = [];
  for (const node of p.nodes) {
    if (node.pipeline?.name) refs.push(node.pipeline.name);
  }
  return refs;
}

function topoSortByPipelineRefs(
  parsedByLayer: Map<string, WorkflowCatalogEntry>,
  warnings: string[],
): WorkflowCatalogEntry[] {
  const out: WorkflowCatalogEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      warnings.push(`Cycle in pipeline references: ${[...path, name].join(' → ')}`);
      return;
    }
    const entry = parsedByLayer.get(name);
    if (!entry) {
      // Reference to a non-existent pipeline. compileYamlPipeline will
      // throw with a clear message at run-time; we just skip in topo.
      return;
    }
    visiting.add(name);
    for (const ref of collectPipelineRefs(entry.workflow)) {
      visit(ref, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    out.push(entry);
  }

  for (const name of parsedByLayer.keys()) visit(name, []);
  return out;
}

// ── Re-exports ──────────────────────────────────────────────

export { type AgentResolver } from './yaml-compiler.js';
export type { AgentDefinition };

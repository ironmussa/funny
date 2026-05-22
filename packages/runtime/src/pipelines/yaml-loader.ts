/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: loader
 * @domain layer: infrastructure
 * @domain depends: yaml-compiler, agent-registry
 *
 * YAML pipeline loader.
 *
 * Reads YAML pipeline definitions from disk in two layers:
 *
 *   1. Built-in defaults at `packages/runtime/src/pipelines/defaults/*.yaml`
 *      (shipped with funny — what every install gets out of the box).
 *
 *   2. User overrides at `<repoRoot>/.funny/pipelines/*.yaml`
 *      (per-repo customization). When a user file declares the same
 *      `name:` as a built-in, the user file wins.
 *
 * Optional Archon-compat layer reads `<repoRoot>/.archon/workflows/*.yaml`
 * if `archonInterop: true` is passed. User files still win over Archon
 * files, which still win over built-ins.
 *
 * Sub-pipeline references (`pipeline: { name: foo }`) are resolved
 * against the merged set of pipelines, so `code-quality` can call
 * `commit` regardless of which layer each comes from.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatParseError,
  parsePipelineYaml,
  type ParsedPipeline,
  type PipelineDefinition,
} from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

import { log } from '../lib/logger.js';
import {
  compileYamlPipeline,
  YamlCompileError,
  type AgentResolver,
  type YamlPipelineContext,
} from './yaml-compiler.js';

// ── Public API ──────────────────────────────────────────────

export interface LoadOptions {
  /** Repository root. Used to find `.funny/pipelines/` and `.archon/workflows/`. */
  repoRoot?: string;
  /** Resolves named agents (`agent: reviewer` → AgentDefinition). */
  resolveAgent: AgentResolver;
  /** If true, also read `<repoRoot>/.archon/workflows/*.yaml`. */
  archonInterop?: boolean;
  /** Override path to the built-in defaults dir (mostly for testing). */
  defaultsDir?: string;
}

export interface LoadedPipeline {
  /** Pipeline name (from the YAML). */
  name: string;
  /** Layer this pipeline came from — useful for debugging. */
  source: 'built-in' | 'user' | 'archon';
  /** Absolute path to the source YAML file. */
  filePath: string;
  /** Compiled, runnable pipeline definition. */
  definition: PipelineDefinition<YamlPipelineContext>;
  /** The parsed (validated) shape, kept for introspection. */
  parsed: ParsedPipeline;
}

export interface LoadResult {
  /** All pipelines, keyed by name. */
  pipelines: Map<string, LoadedPipeline>;
  /** Non-fatal warnings (e.g. a malformed user file was skipped). */
  warnings: string[];
}

/**
 * Load and compile every YAML pipeline visible from the given repo.
 *
 * Throws on:
 *   - Syntax errors in built-in YAMLs (these are bugs in funny — bail loud).
 *   - Compile errors (cycles, etc.) in built-ins.
 *
 * Logs warnings (and continues) on:
 *   - Malformed user/Archon YAMLs (their authors should fix them, but the
 *     rest of the system shouldn't fail because of one bad override).
 */
export async function loadPipelines(opts: LoadOptions): Promise<LoadResult> {
  const warnings: string[] = [];

  const defaultsDir = opts.defaultsDir ?? builtInDefaultsDir();
  const userDir = opts.repoRoot ? path.join(opts.repoRoot, '.funny', 'pipelines') : undefined;
  const archonDir =
    opts.archonInterop && opts.repoRoot
      ? path.join(opts.repoRoot, '.archon', 'workflows')
      : undefined;

  // Read all three layers in parallel — disk-bound, no need to serialize.
  const [builtInFiles, userFiles, archonFiles] = await Promise.all([
    listYamlFiles(defaultsDir, /* required */ true),
    userDir ? listYamlFiles(userDir, false) : Promise.resolve([]),
    archonDir ? listYamlFiles(archonDir, false) : Promise.resolve([]),
  ]);

  // Parse each file into a ParsedPipeline tagged with its layer.
  const parsedByLayer = new Map<string, ParsedAtLayer>();
  await mergeLayer(parsedByLayer, builtInFiles, 'built-in', warnings, /* strict */ true);
  await mergeLayer(parsedByLayer, archonFiles, 'archon', warnings, false);
  await mergeLayer(parsedByLayer, userFiles, 'user', warnings, false);

  // Compile in two passes so `pipeline: { name: ... }` references resolve
  // regardless of declaration order. First pass: compile every pipeline
  // with an EMPTY subPipelines registry (sub-references resolve at run
  // time via the registry that we hand out below). Second pass: build the
  // final registry and rebind.
  //
  // Simpler approach used here: compile in dependency order (referenced
  // pipelines first). If A references B, B must be compiled first. We
  // sort by topological order over `pipeline:` references.
  const ordered = topoSortByPipelineRefs(parsedByLayer, warnings);

  const compiled = new Map<string, LoadedPipeline>();
  for (const entry of ordered) {
    try {
      const subPipelines: Record<string, PipelineDefinition<YamlPipelineContext>> = {};
      for (const ref of collectPipelineRefs(entry.parsed)) {
        const sub = compiled.get(ref);
        if (sub) subPipelines[ref] = sub.definition;
      }
      const definition = compileYamlPipeline(entry.parsed, {
        resolveAgent: opts.resolveAgent,
        subPipelines,
      });
      compiled.set(entry.parsed.name, {
        name: entry.parsed.name,
        source: entry.layer,
        filePath: entry.filePath,
        definition,
        parsed: entry.parsed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (entry.layer === 'built-in') {
        // Bug in funny — loud failure.
        throw err instanceof YamlCompileError ? err : new Error(message);
      }
      warnings.push(`Skipped ${entry.layer} pipeline at ${entry.filePath}: ${message}`);
      log.warn('Pipeline compile failed (non-fatal layer)', {
        namespace: 'yaml-loader',
        filePath: entry.filePath,
        layer: entry.layer,
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

interface ParsedAtLayer {
  parsed: ParsedPipeline;
  filePath: string;
  layer: 'built-in' | 'user' | 'archon';
}

async function mergeLayer(
  acc: Map<string, ParsedAtLayer>,
  files: string[],
  layer: ParsedAtLayer['layer'],
  warnings: string[],
  strict: boolean,
): Promise<void> {
  for (const filePath of files) {
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const note = `Failed to read ${layer} pipeline ${filePath}: ${message}`;
      if (strict) throw new Error(note, { cause: err });
      warnings.push(note);
      continue;
    }
    const result = parsePipelineYaml(source, filePath);
    if (!result.ok) {
      const note = formatParseError(result.error);
      if (strict) throw new Error(note);
      warnings.push(`Skipped ${layer} pipeline at ${filePath}: ${note}`);
      log.warn('Pipeline YAML parse failed (non-fatal layer)', {
        namespace: 'yaml-loader',
        filePath,
        layer,
      });
      continue;
    }
    // User > Archon > Built-in. Replace if we already have a lower-priority entry.
    const existing = acc.get(result.pipeline.name);
    if (!existing || layerRank(layer) > layerRank(existing.layer)) {
      acc.set(result.pipeline.name, { parsed: result.pipeline, filePath, layer });
    }
  }
}

function layerRank(layer: ParsedAtLayer['layer']): number {
  // Higher = wins.
  if (layer === 'user') return 2;
  if (layer === 'archon') return 1;
  return 0;
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

function builtInDefaultsDir(): string {
  // The compiled output sits under dist/, but in dev (Bun + ts-import) the
  // file paths point at the .ts sources. Both layouts have a sibling
  // `defaults/` directory next to this file, so resolve relative to here.
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), 'defaults');
}

function collectPipelineRefs(p: ParsedPipeline): string[] {
  const refs: string[] = [];
  for (const node of p.nodes) {
    if (node.pipeline?.name) refs.push(node.pipeline.name);
  }
  return refs;
}

function topoSortByPipelineRefs(
  parsedByLayer: Map<string, ParsedAtLayer>,
  warnings: string[],
): ParsedAtLayer[] {
  const out: ParsedAtLayer[] = [];
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
    for (const ref of collectPipelineRefs(entry.parsed)) {
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

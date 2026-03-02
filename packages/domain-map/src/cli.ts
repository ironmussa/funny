#!/usr/bin/env bun

import { resolve } from 'path';

import { applyActionsToCode } from './code-writer.js';
import { generateCatalog } from './generators/catalog.js';
import { generateContextMap } from './generators/context-map.js';
import { generateExplorer } from './generators/explorer.js';
import { generateInventory } from './generators/inventory.js';
import { generateJSON } from './generators/json.js';
import { generateMermaid } from './generators/mermaid.js';
import { generateSequence } from './generators/sequence.js';
import { buildEnrichedGraph, parseDirectory } from './parser.js';
import { parseStrategicFile } from './strategic-parser.js';
import { computeCodeToYamlActions, computeYamlToCodeActions } from './sync.js';
import type {
  CLIOptions,
  DomainType,
  DomainGraph,
  EnrichedDomainGraph,
  SyncDirection,
} from './types.js';
import { validateConsistency } from './validator.js';
import { applyActionsToYAML } from './yaml-writer.js';

// ── Argument parsing ─────────────────────────────────────────────

function parseArgs(argv: string[]): CLIOptions {
  const options: CLIOptions = {
    dir: process.cwd(),
    format: 'mermaid',
    eventsOnly: false,
    direction: 'LR',
    showBus: false,
  };

  const filterSubdomain: string[] = [];
  const filterType: DomainType[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;

      case '--output':
      case '-o':
        options.output = argv[++i];
        break;

      case '--format':
      case '-f':
        options.format = argv[++i] as CLIOptions['format'];
        break;

      case '--scenario':
      case '-s':
        options.scenario = argv[++i];
        break;

      case '--show-bus':
        options.showBus = true;
        break;

      case '--subdomain':
      case '-d':
        filterSubdomain.push(argv[++i]);
        break;

      case '--type':
      case '-t':
        filterType.push(argv[++i] as DomainType);
        break;

      case '--events-only':
        options.eventsOnly = true;
        break;

      case '--direction':
        options.direction = argv[++i] as 'LR' | 'TB';
        break;

      case '--domain-file':
        options.domainFile = argv[++i];
        break;

      case '--validate':
        options.validate = true;
        break;

      case '--sync': {
        const next = argv[i + 1];
        if (next === 'yaml-to-code' || next === 'code-to-yaml') {
          options.sync = next as SyncDirection;
          i++;
        } else {
          options.sync = 'code-to-yaml'; // default direction
        }
        break;
      }

      case '--write':
        options.write = true;
        break;

      default:
        // Positional argument: directory
        if (!arg.startsWith('-')) {
          options.dir = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }

    i++;
  }

  if (filterSubdomain.length > 0) options.filterSubdomain = filterSubdomain;
  if (filterType.length > 0) options.filterType = filterType;

  return options;
}

function printHelp(): void {
  console.log(`
domain-map — Parse @domain annotations and generate architecture diagrams

Usage:
  bun packages/domain-map/src/cli.ts [options] [directory]

Options:
  --output, -o <file>       Write output to file (default: stdout)
  --format, -f <format>     Output format: mermaid | json | sequence | catalog | context-map | inventory | explorer (default: mermaid)
  --subdomain, -d <name>    Filter by subdomain (repeatable)
  --type, -t <type>         Filter by DDD type (repeatable)
  --events-only             Show only event flow arrows (mermaid format)
  --direction <dir>         Mermaid direction: LR | TB (default: LR)
  --scenario, -s <family>   Filter to event family (e.g., agent, git, thread)
  --show-bus                Show EventBus as explicit mediator in sequence diagrams
  --domain-file <path>      Path to strategic domain.yaml file
  --validate                Cross-validate YAML against code annotations
  --sync [direction]        Sync YAML ↔ code: code-to-yaml (default) | yaml-to-code
  --write                   Apply sync changes (without: dry-run only)
  --help, -h                Show this help

Examples:
  bun packages/domain-map/src/cli.ts packages/server/src
  bun packages/domain-map/src/cli.ts --format json packages/
  bun packages/domain-map/src/cli.ts --subdomain "Git Operations" --subdomain "Agent Execution" packages/server/src
  bun packages/domain-map/src/cli.ts --type handler --type domain-service packages/server/src
  bun packages/domain-map/src/cli.ts --events-only --direction TB packages/server/src

  # Event-driven views:
  bun packages/domain-map/src/cli.ts --format sequence packages/server/src
  bun packages/domain-map/src/cli.ts --format sequence --scenario agent packages/server/src
  bun packages/domain-map/src/cli.ts --format sequence --show-bus packages/server/src
  bun packages/domain-map/src/cli.ts --format catalog packages/server/src

  # File inventory (which files implement each subdomain):
  bun packages/domain-map/src/cli.ts --format inventory packages/server/src
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --format inventory packages/server/src

  # Architecture explorer (unified view):
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --format explorer packages/server/src

  # Strategic views (with domain.yaml):
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --format context-map packages/server/src
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --validate packages/server/src

  # 2-way sync:
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --sync packages/server/src
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --sync yaml-to-code packages/server/src
  bun packages/domain-map/src/cli.ts --domain-file domain.yaml --sync --write packages/server/src
`);
}

// ── Filtering ────────────────────────────────────────────────────

function applyFilters(graph: DomainGraph, options: CLIOptions): DomainGraph {
  if (!options.filterSubdomain && !options.filterType) return graph;

  const filtered: DomainGraph = {
    nodes: new Map(),
    subdomains: new Map(),
    events: new Set(),
  };

  for (const [key, node] of graph.nodes) {
    if (options.filterSubdomain && !options.filterSubdomain.includes(node.subdomain)) continue;
    if (options.filterType && !options.filterType.includes(node.type)) continue;

    filtered.nodes.set(key, node);

    const members = filtered.subdomains.get(node.subdomain) ?? [];
    members.push(key);
    filtered.subdomains.set(node.subdomain, members);

    if (node.event) filtered.events.add(node.event);
    for (const e of node.emits) filtered.events.add(e);
    for (const e of node.consumes) filtered.events.add(e);
  }

  return filtered;
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const options = parseArgs(args);

  const dir = resolve(options.dir);
  console.error(`Scanning ${dir} for @domain annotations...`);

  const graph = await parseDirectory(dir);

  const nodeCount = graph.nodes.size;
  const subdomainCount = graph.subdomains.size;
  console.error(`Found ${nodeCount} annotated components in ${subdomainCount} subdomains.`);

  // Load strategic model if provided
  let enriched: EnrichedDomainGraph;
  if (options.domainFile) {
    const domainPath = resolve(options.domainFile);
    console.error(`Loading strategic model from ${domainPath}...`);
    const strategic = await parseStrategicFile(domainPath);
    console.error(
      `Strategic model: ${strategic.subdomains.size} subdomains, ${strategic.contextMap.length} relationships, ${strategic.teams.length} teams.`,
    );

    // Build enriched graph with annotations from all files
    const allAnnotations = [...graph.nodes.values()];
    enriched = buildEnrichedGraph(allAnnotations, strategic);
  } else {
    enriched = { ...graph };
  }

  // Cross-validation mode
  if (options.validate) {
    if (!enriched.strategic) {
      console.error('--validate requires --domain-file. Provide a domain.yaml file.');
      process.exit(1);
    }

    const warnings = validateConsistency(enriched, enriched.strategic);

    if (warnings.length === 0) {
      console.log('Validation passed. No inconsistencies found.');
    } else {
      const errors = warnings.filter((w) => w.severity === 'error');
      const warns = warnings.filter((w) => w.severity === 'warning');

      if (errors.length > 0) {
        console.log(`\n--- ERRORS (${errors.length}) ---`);
        for (const e of errors) {
          console.log(`  [${e.code}] ${e.message}`);
        }
      }
      if (warns.length > 0) {
        console.log(`\n--- WARNINGS (${warns.length}) ---`);
        for (const w of warns) {
          console.log(`  [${w.code}] ${w.message}`);
        }
      }

      console.log(`\nTotal: ${errors.length} errors, ${warns.length} warnings.`);
      if (errors.length > 0) process.exit(1);
    }
    return;
  }

  // Sync mode
  if (options.sync) {
    if (!enriched.strategic) {
      console.error('--sync requires --domain-file. Provide a domain.yaml file.');
      process.exit(1);
    }

    const direction = options.sync;
    const actions =
      direction === 'yaml-to-code'
        ? computeYamlToCodeActions(enriched, enriched.strategic)
        : computeCodeToYamlActions(enriched, enriched.strategic);

    if (actions.length === 0) {
      console.log(`Sync (${direction}): Everything is in sync. No changes needed.`);
      return;
    }

    // Print report
    console.log(
      `\n=== ${direction === 'code-to-yaml' ? 'Code → YAML' : 'YAML → Code'} Sync Report ===\n`,
    );
    for (const action of actions) {
      const kindLabel = action.kind.toUpperCase().replace(/-/g, '_');
      console.log(`  [${kindLabel}] ${action.message}`);
    }
    console.log(`\n${actions.length} change(s) detected.`);

    if (options.write) {
      if (direction === 'code-to-yaml') {
        const domainPath = resolve(options.domainFile!);
        const yamlContent = await Bun.file(domainPath).text();
        const updated = applyActionsToYAML(yamlContent, actions);
        await Bun.write(domainPath, updated);
        console.log(`Updated ${options.domainFile}`);
      } else {
        const filePaths = new Set(
          actions.filter((a) => a.kind !== 'notify-unannotated').map((a) => a.target),
        );
        const contents = new Map<string, string>();
        for (const fp of filePaths) {
          const abs = resolve(dir, fp);
          contents.set(fp, await Bun.file(abs).text());
        }
        const patched = applyActionsToCode(contents, actions);
        for (const [fp, content] of patched) {
          await Bun.write(resolve(dir, fp), content);
        }
        console.log(`Updated ${patched.size} source file(s).`);
      }
    } else {
      console.log('Dry run — no files modified. Use --write to apply changes.');
    }
    return;
  }

  // Apply filters for non-context-map formats
  const noFilter = options.format === 'context-map' || options.format === 'explorer';
  const filtered = noFilter ? enriched : applyFilters(enriched, options);

  if (!noFilter && filtered.nodes.size === 0) {
    console.log('No @domain annotations found. Use /domain-annotate to add them.');
    process.exit(0);
  }

  let output: string;
  switch (options.format) {
    case 'json':
      output = generateJSON(filtered);
      break;
    case 'sequence':
      output = generateSequence(filtered, {
        scenario: options.scenario,
        showBus: options.showBus,
      });
      break;
    case 'catalog':
      output = generateCatalog(filtered, { includeHealthCheck: true });
      break;
    case 'context-map':
      output = generateContextMap(enriched, {
        direction: options.direction,
      });
      break;
    case 'inventory':
      output = generateInventory(filtered);
      break;
    case 'explorer':
      output = generateExplorer(enriched);
      break;
    default:
      output = generateMermaid(filtered, {
        direction: options.direction,
        eventsOnly: options.eventsOnly,
      });
      break;
  }

  if (options.output) {
    await Bun.write(options.output, output);
    console.log(`Output written to ${options.output}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

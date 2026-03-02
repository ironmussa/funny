import type {
  DomainAnnotation,
  DomainGraph,
  EnrichedDomainGraph,
  SubdomainType,
} from '../types.js';
import { validateConsistency } from '../validator.js';
import { buildEventAdjacency, groupEventsByFamily } from './event-utils.js';

// ── Options ─────────────────────────────────────────────────────

export interface ExplorerOptions {}

// ── Main generator ──────────────────────────────────────────────

/**
 * Generate a comprehensive architecture overview combining strategic
 * and tactical data into a single Markdown document.
 */
export function generateExplorer(graph: DomainGraph, _options?: ExplorerOptions): string {
  const enriched = graph as EnrichedDomainGraph;
  const strategic = enriched.strategic;
  const lines: string[] = [];

  // Header
  const domainName = strategic?.domain.name ?? 'Project';
  const domainDesc = strategic?.domain.description?.trim();
  lines.push(`# Architecture Explorer: ${domainName}`);
  lines.push('');
  if (domainDesc) {
    lines.push(`> ${domainDesc}`);
    lines.push('');
  }

  const sdCount = graph.subdomains.size;
  const nodeCount = graph.nodes.size;
  const teamCount = strategic?.teams.length ?? 0;
  const relCount = strategic?.contextMap.length ?? 0;
  lines.push(
    `> ${sdCount} subdomains | ${nodeCount} components | ${teamCount} teams | ${relCount} relationships`,
  );
  lines.push('');

  // Build team lookup: BC → team name
  const teamForBC = new Map<string, string>();
  if (strategic) {
    for (const team of strategic.teams) {
      for (const bc of team.owns) teamForBC.set(bc, team.name);
    }
  }

  // Build relationship lookup: BC → relationships where it's upstream
  const upstreamRels = new Map<string, Array<{ downstream: string; label: string }>>();
  if (strategic) {
    for (const rel of strategic.contextMap) {
      const existing = upstreamRels.get(rel.upstream) ?? [];
      existing.push({ downstream: rel.downstream, label: shortRelLabel(rel.relationship) });
      upstreamRels.set(rel.upstream, existing);
    }
  }

  // Group subdomains by type
  const typeOrder: SubdomainType[] = ['core', 'supporting', 'generic'];
  const byType = new Map<string, string[]>();

  for (const sdName of graph.subdomains.keys()) {
    const sdDef = strategic?.subdomains.get(sdName);
    const type = sdDef?.type ?? 'supporting';
    const group = byType.get(type) ?? [];
    group.push(sdName);
    byType.set(type, group);
  }

  // Render subdomains by type
  for (const type of typeOrder) {
    const subdomains = byType.get(type);
    if (!subdomains || subdomains.length === 0) continue;

    lines.push(`## ${type.toUpperCase()} Subdomains`);
    lines.push('');

    for (const sdName of subdomains.sort()) {
      renderSubdomain(lines, graph, enriched, sdName, teamForBC, upstreamRels);
    }
  }

  // Shared Kernel
  if (strategic?.sharedKernel) {
    const skName = strategic.sharedKernel.name;
    const skNodes = graph.subdomains.get(skName);
    if (skNodes && skNodes.length > 0) {
      lines.push(`## Shared Kernel`);
      lines.push('');
      if (strategic.sharedKernel.description) {
        lines.push(`> ${strategic.sharedKernel.description.trim()}`);
        lines.push('');
      }
      renderFileTable(lines, graph, skNodes);
      lines.push('');
    }
  }

  // Context Map table
  if (strategic && strategic.contextMap.length > 0) {
    lines.push('## Context Map');
    lines.push('');
    lines.push('| # | Upstream | Downstream | Relationship | Description |');
    lines.push('|--:|----------|------------|:------------:|-------------|');
    let i = 0;
    for (const rel of strategic.contextMap) {
      i++;
      const desc = rel.description?.trim().replace(/\n/g, ' ') ?? '';
      lines.push(
        `| ${i} | ${rel.upstream} | ${rel.downstream} | ${shortRelLabel(rel.relationship)} | ${desc} |`,
      );
    }
    lines.push('');
  }

  // Event Flow Summary
  const adj = buildEventAdjacency(graph);
  if (adj.size > 0) {
    const families = groupEventsByFamily(adj.keys());
    lines.push('## Event Flow Summary');
    lines.push('');
    lines.push('| Family | Events | Cross-Subdomain | Orphans |');
    lines.push('|--------|-------:|:---------------:|---------|');

    for (const [family, events] of [...families.entries()].sort()) {
      const crossCount = events.filter((e) => {
        const info = adj.get(e)!;
        return isCrossSubdomain(graph, info.emitters, info.consumers);
      }).length;
      const orphans = events.filter((e) => {
        const info = adj.get(e)!;
        return info.emitters.length > 0 && info.consumers.length === 0;
      });
      const orphanStr = orphans.length > 0 ? orphans.map((o) => `\`${o}\``).join(', ') : '—';
      lines.push(`| ${family} | ${events.length} | ${crossCount} | ${orphanStr} |`);
    }
    lines.push('');
  }

  // Health Dashboard
  if (strategic) {
    const warnings = validateConsistency(enriched, strategic);
    const errors = warnings.filter((w) => w.severity === 'error').length;
    const warns = warnings.filter((w) => w.severity === 'warning').length;

    lines.push('## Health Dashboard');
    lines.push('');
    lines.push(`- **YAML-Code consistency**: ${warns} warnings, ${errors} errors`);

    const orphanEvents = [...adj.entries()].filter(
      ([, info]) => info.emitters.length > 0 && info.consumers.length === 0,
    ).length;
    const deadLetters = [...adj.entries()].filter(
      ([, info]) => info.consumers.length > 0 && info.emitters.length === 0,
    ).length;

    lines.push(`- **Orphan events** (emitted, never consumed): ${orphanEvents}`);
    lines.push(`- **Dead-letter events** (consumed, never emitted): ${deadLetters}`);
    lines.push('');
  }

  // Team Ownership
  if (strategic && strategic.teams.length > 0) {
    lines.push('## Team Ownership');
    lines.push('');
    lines.push('| Team | Bounded Contexts | Components |');
    lines.push('|------|-----------------|:----------:|');

    for (const team of strategic.teams) {
      const bcs = team.owns.join(', ');
      let count = 0;
      for (const bc of team.owns) {
        // Find subdomain for this BC
        for (const [sdName, sdDef] of strategic.subdomains) {
          if (sdDef.boundedContext === bc) {
            count += graph.subdomains.get(sdName)?.length ?? 0;
          }
        }
      }
      lines.push(`| ${team.name} | ${bcs} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────

function renderSubdomain(
  lines: string[],
  graph: DomainGraph,
  enriched: EnrichedDomainGraph,
  sdName: string,
  teamForBC: Map<string, string>,
  upstreamRels: Map<string, Array<{ downstream: string; label: string }>>,
): void {
  const strategic = enriched.strategic;
  const sdDef = strategic?.subdomains.get(sdName);
  const bc = sdDef?.boundedContext ?? '';
  const team = bc ? teamForBC.get(bc) : undefined;

  const header = [`### ${sdName}`];
  if (bc) header.push(`(${bc})`);
  if (team) header.push(`— Team: ${team}`);
  lines.push(header.join(' '));
  lines.push('');

  if (sdDef?.description) {
    lines.push(`> ${sdDef.description.trim().replace(/\n/g, ' ')}`);
    lines.push('');
  }

  // File table
  const nodeKeys = graph.subdomains.get(sdName) ?? [];
  renderFileTable(lines, graph, nodeKeys);

  // Events
  if (sdDef?.publishes && sdDef.publishes.length > 0) {
    lines.push(`**Events**: ${sdDef.publishes.map((e) => `\`${e}\``).join(', ')}`);
  }

  // API
  if (sdDef?.exposes && sdDef.exposes.length > 0) {
    lines.push(`**API**: ${sdDef.exposes.join(', ')}`);
  }

  // Relationships
  if (bc) {
    const rels = upstreamRels.get(bc);
    if (rels && rels.length > 0) {
      const relStrs = rels.map((r) => `${r.downstream} (${r.label})`);
      lines.push(`**Upstream of**: ${relStrs.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
}

function renderFileTable(lines: string[], graph: DomainGraph, nodeKeys: string[]): void {
  const nodes = nodeKeys
    .map((k) => graph.nodes.get(k))
    .filter((n): n is DomainAnnotation => n !== undefined)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  if (nodes.length === 0) return;

  lines.push('| File | Name | Type | Layer |');
  lines.push('|------|------|------|-------|');
  for (const node of nodes) {
    const rel = node.filePath.replace(/\\/g, '/');
    lines.push(`| \`${rel}\` | ${node.name} | ${node.type} | ${node.layer} |`);
  }
  lines.push('');
}

function shortRelLabel(relationship: string): string {
  const labels: Record<string, string> = {
    'customer-supplier': 'C/S',
    partnership: 'Partnership',
    conformist: 'Conformist',
    'published-language': 'PL',
    'anti-corruption-layer': 'ACL',
    'open-host-service': 'OHS',
    'shared-kernel': 'SK',
    'separate-ways': 'SW',
  };
  return labels[relationship] ?? relationship;
}

function isCrossSubdomain(graph: DomainGraph, emitters: string[], consumers: string[]): boolean {
  if (emitters.length === 0 || consumers.length === 0) return false;
  const emitterSDs = new Set(emitters.map((k) => graph.nodes.get(k)?.subdomain).filter(Boolean));
  const consumerSDs = new Set(consumers.map((k) => graph.nodes.get(k)?.subdomain).filter(Boolean));
  for (const sd of consumerSDs) {
    if (!emitterSDs.has(sd)) return true;
  }
  return false;
}

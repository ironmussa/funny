/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: SkillsService, McpService
 *
 * Provider-scoped Agent Resources resolver. The SINGLE place that answers
 * "which resources apply to provider X" for Settings (inventory), the composer
 * (suggestions), and the runtime (injection). Consumes the shared provider
 * descriptor so it can never drift from the client.
 *
 * See openspec/changes/agent-resources/design.md.
 */

import {
  PROVIDER_RESOURCE_DESCRIPTORS,
  getProviderResourceDescriptor,
  resourceUsableByProvider,
  type AgentProvider,
  type AgentResource,
  type AgentResourcesResult,
  type McpServer,
  type ResolveAgentResourcesInput,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { ResultAsync, okAsync } from 'neverthrow';

import { listMcpServers } from '../mcp-service.js';
import {
  listCustomCommandResourcesForProvider,
  listSkillResourcesForProvider,
} from '../skills-service.js';

/**
 * Resolve the agent resources visible/usable for a given provider and phase.
 *
 * - `settings`: full inventory — `resources` holds resources usable by the
 *   provider, `hidden` holds incompatible ones (each with a `hiddenReason`) so
 *   the UI can still show them under their owning provider.
 * - `composer` / `runtime`: only `resources` (usable) is meaningful.
 */
export function resolveAgentResources(
  input: ResolveAgentResourcesInput,
): ResultAsync<AgentResourcesResult, DomainError> {
  const { provider, model, phase, projectPath, sessionCommands, claudeConfigDir } = input;
  const descriptor = getProviderResourceDescriptor(provider);

  // Each provider scans only its OWN filesystem skills/commands. For composer/
  // runtime we scan just the effective provider; for the cross-provider Settings
  // inventory we scan every bundled provider so each shows under its own group.
  const providersToScan: AgentProvider[] =
    phase === 'settings' ? Object.keys(PROVIDER_RESOURCE_DESCRIPTORS) : [provider];

  const candidates: AgentResource[] = [];
  for (const p of providersToScan) {
    const d = getProviderResourceDescriptor(p);
    if (d.skills !== 'none') {
      candidates.push(...listSkillResourcesForProvider(p, projectPath, { claudeConfigDir }));
    }
    if (d.customCommands !== 'none') {
      candidates.push(
        ...listCustomCommandResourcesForProvider(p, projectPath, { claudeConfigDir }),
      );
    }
  }

  // Built-in / dynamic commands come ONLY from the live provider session. They
  // belong to whichever provider reported them — compatible with this provider.
  if (sessionCommands?.length) {
    for (const name of sessionCommands) {
      candidates.push({
        kind: 'slash-command',
        name,
        origin: 'provider-session',
        compatibleProviders: [provider],
        usable: true,
        commandTier: 'builtin',
      });
    }
  }

  // Composer autocomplete only consumes skills and slash commands. Listing MCP
  // can shell out to provider CLIs, so keep it off the render-critical path.
  const mcpResult: ResultAsync<McpServer[], DomainError> =
    projectPath && phase !== 'composer'
      ? listMcpServers(projectPath, provider, { claudeConfigDir })
      : okAsync<McpServer[], DomainError>([]);

  return mcpResult
    .orElse(() => okAsync<McpServer[], DomainError>([])) // MCP listing failure → no MCP, not a hard error
    .map((servers) => finalize({ candidates, mcp: servers, descriptor, provider, model }));
}

function finalize(args: {
  candidates: AgentResource[];
  mcp: McpServer[];
  descriptor: ReturnType<typeof getProviderResourceDescriptor>;
  provider: ResolveAgentResourcesInput['provider'];
  model?: string;
}): AgentResourcesResult {
  const { candidates, mcp, descriptor, provider, model } = args;

  const all: AgentResource[] = [...candidates];

  // MCP servers are shareable (`compatibleProviders: 'all'`) but capability- and
  // policy-gated per provider.
  for (const srv of mcp) {
    const transportSupported =
      descriptor.mcp.supported && descriptor.mcp.transports.includes(srv.type);
    let usable = transportSupported && !srv.disabled;
    let hiddenReason: AgentResource['hiddenReason'];
    if (srv.disabled) {
      usable = false;
      hiddenReason = 'disabled';
    } else if (!transportSupported) {
      usable = false;
      hiddenReason = 'unsupported_transport';
    } else if (srv.status === 'needs_auth') {
      usable = false;
      hiddenReason = 'needs_auth';
    }
    all.push({
      kind: 'mcp-server',
      name: srv.name,
      origin: srv.source === 'project' ? 'mcp-project' : 'mcp-user',
      compatibleProviders: 'all',
      usable,
      hiddenReason,
      transport: srv.type,
      scope: srv.source === 'project' ? 'project' : 'global',
    });
  }

  const resources: AgentResource[] = [];
  const hidden: AgentResource[] = [];
  for (const r of all) {
    // Non-MCP resources derive usability from their compatibility allow-list.
    if (r.kind !== 'mcp-server' && r.compatibleProviders !== 'all') {
      const ok = resourceUsableByProvider(r, provider);
      const resolved: AgentResource = ok
        ? { ...r, usable: true }
        : { ...r, usable: false, hiddenReason: r.hiddenReason ?? 'provider_mismatch' };
      (ok ? resources : hidden).push(resolved);
      continue;
    }
    (r.usable ? resources : hidden).push(r);
  }

  return { provider, model, resources, hidden };
}

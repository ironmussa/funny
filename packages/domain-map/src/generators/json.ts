import type { DomainGraph, EnrichedDomainGraph } from '../types.js';

/**
 * Serialize a DomainGraph to JSON for programmatic consumption.
 * If the graph is enriched, includes strategic model data.
 */
export function generateJSON(graph: DomainGraph): string {
  const enriched = graph as EnrichedDomainGraph;
  const strategic = enriched.strategic;

  return JSON.stringify(
    {
      nodes: Object.fromEntries(graph.nodes),
      subdomains: Object.fromEntries([...graph.subdomains].map(([k, v]) => [k, v])),
      events: [...graph.events],
      ...(strategic && {
        strategic: {
          domain: strategic.domain,
          subdomains: Object.fromEntries(strategic.subdomains),
          sharedKernel: strategic.sharedKernel,
          contextMap: strategic.contextMap,
          teams: strategic.teams,
        },
      }),
    },
    null,
    2,
  );
}

import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { getSubdomainNodes, getSubdomainType } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';

export function DetailPanel() {
  const graph = useDomainStore((s) => s.graph);
  const selected = useDomainStore((s) => s.selectedSubdomain);
  const select = useDomainStore((s) => s.selectSubdomain);

  if (!graph || !selected) return null;

  const nodes = getSubdomainNodes(graph, selected);
  const sdType = getSubdomainType(graph, selected);
  const strategic = graph.strategic?.subdomains[selected];
  const team = graph.strategic?.teams.find((t) => t.owns.includes(strategic?.boundedContext ?? ''));

  const allEmits = [...new Set(nodes.flatMap((n) => n.emits))].sort();
  const allConsumes = [...new Set(nodes.flatMap((n) => n.consumes))].sort();

  return (
    <div className="border-t bg-card" data-testid="detail-panel">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{selected}</h3>
          <Badge variant={sdType}>{sdType}</Badge>
          {strategic?.boundedContext && (
            <span className="text-xs text-muted-foreground">BC: {strategic.boundedContext}</span>
          )}
          {team && <span className="text-xs text-muted-foreground">Team: {team.name}</span>}
          <span className="text-xs text-muted-foreground">{nodes.length} components</span>
        </div>
        <button
          data-testid="detail-panel-close"
          onClick={() => select(null)}
          className="rounded p-1 hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <Separator />

      <div className="flex gap-6 px-4 py-3 text-sm">
        <div className="flex-1">
          <h4 className="mb-1 font-medium">Files</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-3">File</th>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1">Layer</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.filePath + n.name} className="border-b border-border/50">
                  <td className="max-w-[200px] truncate py-1 pr-3 font-mono text-muted-foreground">
                    {n.filePath.split('/').pop()}
                  </td>
                  <td className="py-1 pr-3">{n.name}</td>
                  <td className="py-1 pr-3 text-muted-foreground">{n.type}</td>
                  <td className="py-1 text-muted-foreground">{n.layer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Separator orientation="vertical" className="h-auto" />

        <div className="w-64 shrink-0">
          <h4 className="mb-1 font-medium">Events</h4>
          {allEmits.length > 0 && (
            <div className="mb-2">
              <span className="text-xs font-medium text-muted-foreground">Emits:</span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {allEmits.map((e) => (
                  <code
                    key={e}
                    className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                  >
                    {e}
                  </code>
                ))}
              </div>
            </div>
          )}
          {allConsumes.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Consumes:</span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {allConsumes.map((e) => (
                  <code
                    key={e}
                    className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                  >
                    {e}
                  </code>
                ))}
              </div>
            </div>
          )}
          {allEmits.length === 0 && allConsumes.length === 0 && (
            <p className="text-xs text-muted-foreground">No events</p>
          )}
        </div>
      </div>
    </div>
  );
}

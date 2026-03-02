import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { getSubdomainType } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';
import type { SubdomainType } from '@/types/domain';

const TYPE_LABELS: Record<SubdomainType, string> = {
  core: 'Core',
  supporting: 'Supporting',
  generic: 'Generic',
};

export function Sidebar() {
  const graph = useDomainStore((s) => s.graph);
  const typeFilter = useDomainStore((s) => s.typeFilter);
  const subdomainFilter = useDomainStore((s) => s.subdomainFilter);
  const toggleTypeFilter = useDomainStore((s) => s.toggleTypeFilter);
  const toggleSubdomainFilter = useDomainStore((s) => s.toggleSubdomainFilter);

  if (!graph) return null;

  const subdomains = Object.keys(graph.subdomains).sort();
  const warnings = graph.warnings ?? [];
  const errorCount = warnings.filter((w) => w.severity === 'error').length;
  const warnCount = warnings.filter((w) => w.severity === 'warning').length;

  return (
    <div className="flex h-full w-56 flex-col border-r bg-card">
      <div className="px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filter
        </h2>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 px-3">
          {(['core', 'supporting', 'generic'] as SubdomainType[]).map((type) => (
            <label
              key={type}
              data-testid={`filter-type-${type}`}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={typeFilter.has(type)}
                onChange={() => toggleTypeFilter(type)}
                className="h-3.5 w-3.5 rounded border-muted-foreground"
              />
              <Badge variant={type} className="text-[10px]">
                {TYPE_LABELS[type]}
              </Badge>
            </label>
          ))}
        </div>

        <Separator className="my-3" />

        <div className="px-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Subdomains
          </h3>
          <div className="space-y-0.5">
            {subdomains.map((sd) => {
              const sdType = getSubdomainType(graph, sd);
              if (!typeFilter.has(sdType)) return null;
              return (
                <label
                  key={sd}
                  data-testid={`filter-subdomain-${sd}`}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={subdomainFilter.has(sd)}
                    onChange={() => toggleSubdomainFilter(sd)}
                    className="h-3.5 w-3.5 rounded border-muted-foreground"
                  />
                  <span className="truncate">{sd}</span>
                </label>
              );
            })}
          </div>
        </div>

        <Separator className="my-3" />

        <div className="space-y-1.5 px-3 pb-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Health
          </h3>
          <div className="flex items-center gap-2 text-sm">
            {warnCount > 0 ? (
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
            ) : (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
            )}
            <span>{warnCount} warnings</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {errorCount > 0 ? (
              <XCircle className="h-3.5 w-3.5 text-red-500" />
            ) : (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
            )}
            <span>{errorCount} errors</span>
          </div>

          {graph.strategic?.teams && graph.strategic.teams.length > 0 && (
            <>
              <Separator className="my-2" />
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Teams
              </h3>
              {graph.strategic.teams.map((team) => (
                <div key={team.name} className="text-sm text-muted-foreground">
                  {team.name} <span className="text-xs">({team.owns.length})</span>
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

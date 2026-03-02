import { AlertTriangle, CheckCircle, XCircle, BarChart3, FileText, Zap, Users } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { buildEventInfo, getSubdomainType } from '@/lib/transform';
import { useDomainStore } from '@/stores/domain-store';
import type { SubdomainType } from '@/types/domain';

export function HealthView() {
  const graph = useDomainStore((s) => s.graph);

  const metrics = useMemo(() => {
    if (!graph) return null;

    const events = buildEventInfo(graph);
    const orphans = events.filter((e) => e.isOrphan);
    const deadLetters = events.filter((e) => e.isDeadLetter);
    const crossSd = events.filter((e) => e.isCrossSubdomain);

    const warnings = graph.warnings ?? [];
    const errors = warnings.filter((w) => w.severity === 'error');
    const warns = warnings.filter((w) => w.severity === 'warning');

    // Type distribution
    const typeDist: Record<SubdomainType, number> = { core: 0, supporting: 0, generic: 0 };
    for (const sd of Object.keys(graph.subdomains)) {
      const t = getSubdomainType(graph, sd);
      typeDist[t]++;
    }

    // Layer distribution
    const layerDist: Record<string, number> = {};
    for (const node of Object.values(graph.nodes)) {
      layerDist[node.layer] = (layerDist[node.layer] ?? 0) + 1;
    }

    return {
      subdomainCount: Object.keys(graph.subdomains).length,
      componentCount: Object.keys(graph.nodes).length,
      eventCount: graph.events.length,
      teamCount: graph.strategic?.teams.length ?? 0,
      relationshipCount: graph.strategic?.contextMap.length ?? 0,
      orphans,
      deadLetters,
      crossSd,
      errors,
      warns,
      warnings,
      typeDist,
      layerDist,
    };
  }, [graph]);

  if (!graph || !metrics) return null;

  return (
    <ScrollArea className="h-full" data-testid="health-view">
      <div className="space-y-6 p-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            icon={<BarChart3 className="h-4 w-4" />}
            label="Subdomains"
            value={metrics.subdomainCount}
          />
          <MetricCard
            icon={<FileText className="h-4 w-4" />}
            label="Components"
            value={metrics.componentCount}
          />
          <MetricCard
            icon={<Zap className="h-4 w-4" />}
            label="Events"
            value={metrics.eventCount}
          />
          <MetricCard
            icon={<Users className="h-4 w-4" />}
            label="Teams"
            value={metrics.teamCount}
          />
        </div>

        {/* Type distribution */}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Subdomain Types</h3>
          <div className="flex gap-3">
            {(Object.entries(metrics.typeDist) as [SubdomainType, number][]).map(
              ([type, count]) => (
                <div key={type} className="flex items-center gap-2">
                  <Badge variant={type}>{type}</Badge>
                  <span className="text-sm">{count}</span>
                </div>
              ),
            )}
          </div>
        </div>

        {/* Layer distribution */}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Layer Distribution</h3>
          <div className="flex gap-4">
            {Object.entries(metrics.layerDist)
              .sort((a, b) => b[1] - a[1])
              .map(([layer, count]) => (
                <div key={layer} className="text-sm">
                  <span className="font-medium">{layer}</span>{' '}
                  <span className="text-muted-foreground">{count}</span>
                </div>
              ))}
          </div>
        </div>

        <Separator />

        {/* Event health */}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Event Health</h3>
          <div className="space-y-2 text-sm">
            <HealthRow
              icon={
                metrics.orphans.length > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                )
              }
              label="Orphan events"
              value={metrics.orphans.length}
              detail={
                metrics.orphans.length > 0
                  ? metrics.orphans.map((e) => e.event).join(', ')
                  : undefined
              }
            />
            <HealthRow
              icon={
                metrics.deadLetters.length > 0 ? (
                  <XCircle className="h-4 w-4 text-orange-500" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                )
              }
              label="Dead letter events"
              value={metrics.deadLetters.length}
              detail={
                metrics.deadLetters.length > 0
                  ? metrics.deadLetters.map((e) => e.event).join(', ')
                  : undefined
              }
            />
            <HealthRow
              icon={<Zap className="h-4 w-4 text-blue-500" />}
              label="Cross-subdomain events"
              value={metrics.crossSd.length}
            />
          </div>
        </div>

        <Separator />

        {/* Validation warnings */}
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Validation ({metrics.errors.length} errors, {metrics.warns.length} warnings)
          </h3>
          {metrics.warnings.length === 0 ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              No validation issues found.
            </p>
          ) : (
            <div className="space-y-1">
              {metrics.warnings.map((w, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs ${
                    w.severity === 'error'
                      ? 'bg-red-50 dark:bg-red-950/20'
                      : 'bg-yellow-50 dark:bg-yellow-950/20'
                  }`}
                >
                  {w.severity === 'error' ? (
                    <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-yellow-500" />
                  )}
                  <span>
                    <code className="mr-1 font-mono text-muted-foreground">[{w.code}]</code>
                    {w.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function HealthRow({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <div>
        <span>
          {label}: <strong>{value}</strong>
        </span>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

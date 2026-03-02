import { Network, Zap, Map, Activity } from 'lucide-react';

import { ContextMapView } from '@/components/context-map/context-map-view';
import { DataLoader } from '@/components/data-loader';
import { DetailPanel } from '@/components/detail-panel';
import { EventsView } from '@/components/events/events-view';
import { GraphView } from '@/components/graph/graph-view';
import { HealthView } from '@/components/health/health-view';
import { Sidebar } from '@/components/sidebar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useDomainStore } from '@/stores/domain-store';

export function App() {
  const graph = useDomainStore((s) => s.graph);
  const selectedSubdomain = useDomainStore((s) => s.selectedSubdomain);

  if (!graph) {
    return <DataLoader />;
  }

  const subdomainCount = Object.keys(graph.subdomains).length;
  const componentCount = Object.keys(graph.nodes).length;
  const eventCount = graph.events.length;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div>
          <h1 className="text-lg font-semibold">
            Architecture Explorer
            {graph.strategic?.domain.name && (
              <span className="text-muted-foreground"> — {graph.strategic.domain.name}</span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground">
            {subdomainCount} subdomains · {componentCount} components · {eventCount} events
            {graph.strategic?.teams && ` · ${graph.strategic.teams.length} teams`}
          </p>
        </div>
        <button
          data-testid="reload-button"
          onClick={() => useDomainStore.getState().setGraph(null as never)}
          className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
        >
          Load another file
        </button>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <div className="flex flex-1 flex-col overflow-hidden">
          <Tabs defaultValue="graph" className="flex flex-1 flex-col overflow-hidden">
            <div className="border-b px-4">
              <TabsList className="h-9">
                <TabsTrigger value="graph" data-testid="tab-graph" className="gap-1.5">
                  <Network className="h-3.5 w-3.5" />
                  Graph
                </TabsTrigger>
                <TabsTrigger value="events" data-testid="tab-events" className="gap-1.5">
                  <Zap className="h-3.5 w-3.5" />
                  Events
                </TabsTrigger>
                <TabsTrigger value="context-map" data-testid="tab-context-map" className="gap-1.5">
                  <Map className="h-3.5 w-3.5" />
                  Context Map
                </TabsTrigger>
                <TabsTrigger value="health" data-testid="tab-health" className="gap-1.5">
                  <Activity className="h-3.5 w-3.5" />
                  Health
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="graph" className="flex-1 overflow-hidden">
              <GraphView />
            </TabsContent>
            <TabsContent value="events" className="flex-1 overflow-hidden">
              <EventsView />
            </TabsContent>
            <TabsContent value="context-map" className="flex-1 overflow-hidden">
              <ContextMapView />
            </TabsContent>
            <TabsContent value="health" className="flex-1 overflow-hidden">
              <HealthView />
            </TabsContent>
          </Tabs>

          {/* Detail panel at bottom */}
          {selectedSubdomain && <DetailPanel />}
        </div>
      </div>
    </div>
  );
}

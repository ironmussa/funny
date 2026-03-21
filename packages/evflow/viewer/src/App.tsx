import { ReactFlowProvider } from '@xyflow/react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

import { DataLoader } from './components/data-loader';
import { ElementsView } from './components/elements-view';
import { GraphView } from './components/graph-view';
import { SequencesView } from './components/sequences-view';
import { Sidebar } from './components/sidebar';
import { SourcePanel } from './components/source-panel';
import { useViewerStore } from './stores/viewer-store';

export function App() {
  const model = useViewerStore((s) => s.model);
  const activeTab = useViewerStore((s) => s.activeTab);
  const setActiveTab = useViewerStore((s) => s.setActiveTab);
  const sourcePanelOpen = useViewerStore((s) => s.sourcePanelOpen);

  if (!model) {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <DataLoader />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="flex h-screen w-screen">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as 'graph' | 'elements' | 'sequences')}
            className="flex flex-1 flex-col overflow-hidden"
          >
            <div
              className="flex items-center gap-2 border-b px-3 py-2"
              data-testid="viewer-tab-bar"
            >
              <TabsList>
                <TabsTrigger value="graph" data-testid="viewer-tab-graph">
                  Graph
                </TabsTrigger>
                <TabsTrigger value="elements" data-testid="viewer-tab-elements">
                  Elements
                </TabsTrigger>
                <TabsTrigger value="sequences" data-testid="viewer-tab-sequences">
                  Sequences
                </TabsTrigger>
              </TabsList>

              <div className="flex-1" />
              <DataLoader />
            </div>

            <TabsContent value="graph" className="mt-0 flex-1 overflow-hidden">
              <GraphView />
            </TabsContent>
            <TabsContent value="elements" className="mt-0 flex-1 overflow-hidden">
              <ElementsView />
            </TabsContent>
            <TabsContent value="sequences" className="mt-0 flex-1 overflow-hidden">
              <SequencesView />
            </TabsContent>
          </Tabs>
        </div>

        {sourcePanelOpen && (
          <div className="flex h-full w-96 shrink-0 flex-col border-l">
            <SourcePanel />
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
}

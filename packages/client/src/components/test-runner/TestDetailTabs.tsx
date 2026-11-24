import type {
  TestNetworkEntry,
  WSTestActionData,
  WSTestConsoleData,
  WSTestErrorData,
} from '@funny/shared';
import {
  AlertTriangle,
  Crosshair,
  FileCode,
  Globe,
  Paperclip,
  Phone,
  ScrollText,
  Tag,
  Terminal,
} from 'lucide-react';

import { AnnotationsTab } from '@/components/test-runner/detail-tabs/AnnotationsTab';
import { CallTab } from '@/components/test-runner/detail-tabs/CallTab';
import { ConsoleTab } from '@/components/test-runner/detail-tabs/ConsoleTab';
import { ErrorsTab } from '@/components/test-runner/detail-tabs/ErrorsTab';
import { LogTab } from '@/components/test-runner/detail-tabs/LogTab';
import { NetworkTab } from '@/components/test-runner/detail-tabs/NetworkTab';
import type { OutputLine } from '@/components/test-runner/detail-tabs/shared';
import { SourceTab } from '@/components/test-runner/detail-tabs/SourceTab';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface TestDetailTabsProps {
  outputLines: OutputLine[];
  consoleEntries: WSTestConsoleData[];
  networkEntries: TestNetworkEntry[];
  errorEntries: WSTestErrorData[];
  actions?: WSTestActionData[];
  activeFile: string | null;
  projectPath: string | undefined;
}

// ─── Placeholder Tab ───────────────────────────────────────

function PlaceholderTab({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
      {label}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────

export function TestDetailTabs({
  outputLines,
  consoleEntries,
  networkEntries,
  errorEntries,
  actions,
  activeFile,
  projectPath,
}: TestDetailTabsProps) {
  return (
    <Tabs defaultValue="log" className="flex h-full flex-col">
      <TabsList
        className="h-auto w-full justify-start gap-0 rounded-none border-b bg-transparent p-0"
        data-testid="test-detail-tabs"
      >
        <TabTrigger value="locator" icon={<Crosshair className="size-3.5" />} label="Locator" />
        <TabTrigger value="source" icon={<FileCode className="size-3.5" />} label="Source" />
        <TabTrigger value="call" icon={<Phone className="size-3.5" />} label="Call" />
        <TabTrigger value="log" icon={<ScrollText className="size-3.5" />} label="Log" />
        <TabTrigger
          value="errors"
          icon={<AlertTriangle className="size-3.5" />}
          label="Errors"
          count={errorEntries.length}
        />
        <TabTrigger
          value="console"
          icon={<Terminal className="size-3.5" />}
          label="Console"
          count={consoleEntries.length}
        />
        <TabTrigger
          value="network"
          icon={<Globe className="size-3.5" />}
          label="Network"
          count={networkEntries.length}
        />
        <TabTrigger
          value="attachments"
          icon={<Paperclip className="size-3.5" />}
          label="Attachments"
        />
        <TabTrigger value="annotations" icon={<Tag className="size-3.5" />} label="Annotations" />
      </TabsList>

      <div className="min-h-0 flex-1">
        <TabsContent value="locator" className="mt-0 h-full">
          <PlaceholderTab label="Locator" />
        </TabsContent>
        <TabsContent value="source" className="mt-0 h-full">
          <SourceTab activeFile={activeFile} projectPath={projectPath} />
        </TabsContent>
        <TabsContent value="call" className="mt-0 h-full">
          <CallTab outputLines={outputLines} structuredActions={actions} />
        </TabsContent>
        <TabsContent value="log" className="mt-0 h-full">
          <LogTab outputLines={outputLines} />
        </TabsContent>
        <TabsContent value="errors" className="mt-0 h-full">
          <ErrorsTab entries={errorEntries} />
        </TabsContent>
        <TabsContent value="console" className="mt-0 h-full">
          <ConsoleTab entries={consoleEntries} />
        </TabsContent>
        <TabsContent value="network" className="mt-0 h-full">
          <NetworkTab entries={networkEntries} />
        </TabsContent>
        <TabsContent value="attachments" className="mt-0 h-full">
          <PlaceholderTab label="Attachments" />
        </TabsContent>
        <TabsContent value="annotations" className="mt-0 h-full">
          <AnnotationsTab outputLines={outputLines} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

// ─── Tab Trigger with optional count badge ─────────────────

function TabTrigger({
  value,
  icon,
  label,
  count,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <TabsTrigger
      value={value}
      className="data-[state=active]:border-primary gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
      data-testid={`test-detail-tab-${value}`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <Badge size="xxs" variant="secondary" className="ml-1 min-w-[16px]">
          {count}
        </Badge>
      )}
    </TabsTrigger>
  );
}

import type {
  TestConsoleLevel,
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
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { CodeViewer } from '@/components/ui/code-viewer';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

import { NetworkTab } from './NetworkTab';
import { DetailTooltip, shortenUrl, withStableOccurrenceKeys } from './test-detail-utils';

interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

interface TestDetailTabsProps {
  outputLines: OutputLine[];
  consoleEntries: WSTestConsoleData[];
  networkEntries: TestNetworkEntry[];
  errorEntries: WSTestErrorData[];
  actions?: WSTestActionData[];
  activeFile: string | null;
  projectPath: string | undefined;
}

/** Resolve a CSS variable (HSL) to a string for ansi-to-html. */
/** The foreground and background colors of ANSI output. */
interface AnsiColors {
  fg: string;
  bg: string;
}

/** The theme colors ANSI output is drawn with, read again after a theme switch. */
function readAnsiColors(): AnsiColors {
  return { fg: getCssVar('--foreground'), bg: getCssVar('--background') };
}

function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

const CONSOLE_LEVEL_STYLES: Record<TestConsoleLevel, string> = {
  error: 'text-status-error',
  warn: 'text-status-warning',
  info: 'text-status-info',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
  log: '',
};

const CONSOLE_LEVEL_ICONS: Record<TestConsoleLevel, string> = {
  error: 'x',
  warn: '!',
  info: 'i',
  debug: 'd',
  log: '>',
  trace: 't',
};

// ─── Tab: Log ──────────────────────────────────────────────

function LogTab({ outputLines }: { outputLines: OutputLine[] }) {
  const logRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  // Observe the <html> class attribute to detect theme changes so the ANSI
  // converter re-creates with fresh CSS variable values after a theme switch.
  const [ansiColors, setAnsiColors] = useState(readAnsiColors);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setAnsiColors(readAnsiColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const ansiConverter = useMemo(
    () => createAnsiConverter({ ...ansiColors, newline: false }),
    [ansiColors],
  );
  const keyedOutputLines = useMemo(
    () =>
      withStableOccurrenceKeys(
        outputLines,
        ({ line, stream, timestamp }) => `${timestamp}\u0000${stream}\u0000${line}`,
      ),
    [outputLines],
  );

  useEffect(() => {
    if (!logRef.current || userScrolled.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [outputLines.length]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  return (
    <ScrollArea
      viewportRef={logRef}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {outputLines.length === 0 ? (
        <div className="text-muted-foreground flex h-full items-center justify-center">
          Test output will appear here…
        </div>
      ) : (
        <pre className="text-foreground px-3 py-1 leading-relaxed wrap-break-word whitespace-pre-wrap">
          {keyedOutputLines.map(({ key, value: line }) => (
            <div
              key={key}
              className={cn(line.stream === 'stderr' ? 'text-destructive' : '')}
              dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(line.line) }}
            />
          ))}
        </pre>
      )}
    </ScrollArea>
  );
}

// ─── Tab: Console ──────────────────────────────────────────

function ConsoleTab({ entries }: { entries: WSTestConsoleData[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const keyedEntries = useMemo(
    () =>
      withStableOccurrenceKeys(
        entries,
        ({ column, level, line, text, timestamp, url }) =>
          `${timestamp}\u0000${level}\u0000${url ?? ''}\u0000${line ?? ''}\u0000${column ?? ''}\u0000${text}`,
      ),
    [entries],
  );

  useEffect(() => {
    if (!ref.current || userScrolled.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  return (
    <ScrollArea
      viewportRef={ref}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {entries.length === 0 ? (
        <div className="text-muted-foreground flex h-full items-center justify-center">
          Browser console messages will appear here…
        </div>
      ) : (
        <div>
          {keyedEntries.map(({ key, value: entry }) => (
            <div
              key={key}
              className={cn(
                'flex items-start gap-2 border-b border-border/30 px-3 py-1',
                CONSOLE_LEVEL_STYLES[entry.level] ?? '',
              )}
            >
              <span className="mt-0.5 w-3 shrink-0 text-center font-bold opacity-60">
                {CONSOLE_LEVEL_ICONS[entry.level] ?? '>'}
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{entry.text}</span>
              {entry.url && (
                <DetailTooltip label={entry.url}>
                  <span className="text-muted-foreground shrink-0">
                    {shortenUrl(entry.url)}
                    {entry.line != null ? `:${entry.line}` : ''}
                  </span>
                </DetailTooltip>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

// ─── Tab: Errors ───────────────────────────────────────────

function ErrorsTab({ entries }: { entries: WSTestErrorData[] }) {
  const keyedEntries = useMemo(
    () =>
      withStableOccurrenceKeys(
        entries,
        ({ column, line, message, source, stack, timestamp }) =>
          `${timestamp}\u0000${source ?? ''}\u0000${line ?? ''}\u0000${column ?? ''}\u0000${message}\u0000${stack ?? ''}`,
      ),
    [entries],
  );

  return (
    <ScrollArea className="h-full font-mono text-xs">
      {entries.length === 0 ? (
        <EmptyState title="No errors captured" />
      ) : (
        <div>
          {keyedEntries.map(({ key, value: entry }) => (
            <div key={key} className="border-border/30 border-b px-3 py-2">
              <div className="text-status-error flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span className="break-all whitespace-pre-wrap">{entry.message}</span>
              </div>
              {entry.source && (
                <div className="text-muted-foreground mt-1 ml-5">
                  {entry.source}
                  {entry.line != null ? `:${entry.line}` : ''}
                  {entry.column != null ? `:${entry.column}` : ''}
                </div>
              )}
              {entry.stack && (
                <pre className="text-muted-foreground/80 mt-1 ml-5 whitespace-pre-wrap">
                  {entry.stack}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

// ─── Tab: Source ───────────────────────────────────────────

/** The content of `fullPath`, read from the runner; null clears it. */
function useSourceFile(fullPath: string | null) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new file starts loading; no file clears the view. Starts from null so a
  // file present on mount loads too.
  const [shownPath, setShownPath] = useState<string | null>(null);
  if (shownPath !== fullPath) {
    setShownPath(fullPath);
    setError(null);
    if (fullPath) setLoading(true);
    else setCode(null);
  }

  useEffect(() => {
    if (!fullPath) return;
    api.readFile(fullPath).then((result) => {
      if (result.isOk()) {
        setCode(result.value.content);
      } else {
        setError('Failed to load file');
      }
      setLoading(false);
    });
  }, [fullPath]);

  return { code, loading, error };
}

function SourceTab({
  activeFile,
  projectPath,
}: {
  activeFile: string | null;
  projectPath: string | undefined;
}) {
  const fullPath = activeFile && projectPath ? `${projectPath}/${activeFile}` : null;
  const { code, loading, error } = useSourceFile(fullPath);

  const language = useMemo(() => {
    if (!activeFile) return 'typescript';
    const ext = activeFile.split('.').pop() ?? '';
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'js' || ext === 'jsx') return 'javascript';
    return 'typescript';
  }, [activeFile]);

  if (!activeFile) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Run a test to view its source
      </div>
    );
  }
  if (loading) {
    return <LoadingState testId="test-detail-source-loading" label="Loading…" />;
  }
  if (error) {
    return (
      <div className="text-destructive flex h-full items-center justify-center text-xs">
        {error}
      </div>
    );
  }
  if (!code) {
    return <EmptyState title="No source available" />;
  }

  return (
    <div className="h-full overflow-auto">
      <div className="text-muted-foreground border-b px-3 py-1 text-xs">{activeFile}</div>
      <CodeViewer code={code} language={language} maxHeight="none" className="h-full" />
    </div>
  );
}

// ─── Tab: Call ─────────────────────────────────────────────

/** Regex to match Playwright action lines from --reporter=line output */
const PLAYWRIGHT_SNIPPETS = [
  'page.goto',
  'page.click',
  'page.fill',
  'page.type',
  'page.press',
  'page.waitFor',
  'locator.',
  'expect(',
  'navigating to',
  'waiting for',
];
const ACTION_PATTERN =
  /^(\s*)(\d+\s+\|)?\s*(page\.|locator\.|expect\(|await\s+(?:page|locator|expect))/;
const STEP_PATTERN = /^(\s*)(›|→|⮕|➤|\d+\))\s+(.+)/;

interface ActionEntry {
  text: string;
  timestamp: number;
  isError: boolean;
}

function CallTab({
  outputLines,
  structuredActions,
}: {
  outputLines: OutputLine[];
  structuredActions?: WSTestActionData[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  // Use structured actions if available, else fall back to regex parsing
  const hasStructured = structuredActions && structuredActions.length > 0;

  // Extract Playwright action-like lines from output (fallback)
  const parsedActions = useMemo(() => {
    if (hasStructured) return [];
    const result: ActionEntry[] = [];
    for (const line of outputLines) {
      const text = line.line.trim();
      if (!text) continue;
      if (
        ACTION_PATTERN.test(text) ||
        STEP_PATTERN.test(text) ||
        PLAYWRIGHT_SNIPPETS.some((s) => text.includes(s)) ||
        /^\s*\d+\s*\|/.test(text)
      ) {
        result.push({
          text,
          timestamp: line.timestamp,
          isError: line.stream === 'stderr',
        });
      }
    }
    return result;
  }, [outputLines, hasStructured]);

  const itemCount = hasStructured ? structuredActions!.length : parsedActions.length;

  useEffect(() => {
    if (!ref.current || userScrolled.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [itemCount]);

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  if (itemCount === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Playwright actions will appear here during test execution…
      </div>
    );
  }

  return (
    <ScrollArea
      viewportRef={ref}
      viewportProps={{ onScroll: handleScroll }}
      className="h-full font-mono text-xs"
    >
      {hasStructured ? (
        <div>
          {structuredActions!.map((action) => (
            <div
              key={action.id}
              className={cn(
                'border-b border-border/20 px-3 py-1',
                action.error && 'text-destructive',
              )}
              data-testid={`call-action-${action.id}`}
            >
              <span className="text-muted-foreground">
                {action.category === 'expect' ? '✓ ' : '● '}
              </span>
              {action.title}
              {action.duration != null && (
                <span className="text-muted-foreground ml-2">
                  {action.duration < 1000
                    ? `${Math.round(action.duration)}ms`
                    : `${(action.duration / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div>
          {withStableOccurrenceKeys(
            parsedActions,
            ({ isError, text, timestamp }) => `${timestamp}\u0000${isError}\u0000${text}`,
          ).map(({ key, value: action }) => (
            <div
              key={key}
              className={cn(
                'border-b border-border/20 px-3 py-1',
                action.isError && 'text-destructive',
              )}
            >
              {action.text}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

// ─── Tab: Annotations ─────────────────────────────────────

interface Annotation {
  type: string;
  description: string;
}

function AnnotationsTab({ outputLines }: { outputLines: OutputLine[] }) {
  // Extract annotations from Playwright output
  // Playwright reporter=line prints annotations like:
  //   - @tag, @slow, @fixme, @skip, @fail, test.info().annotations
  const annotations = useMemo(() => {
    const result: Annotation[] = [];
    const seen = new Set<string>();
    for (const line of outputLines) {
      const text = line.line.trim();
      // Match annotation tags: @slow, @fixme, @skip, @fail, etc.
      const tagMatches = text.matchAll(/@(\w+)(?:\s*[:(]\s*(.+?)\s*[):]?)?/g);
      for (const match of tagMatches) {
        const key = `${match[1]}:${match[2] ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ type: match[1], description: match[2] ?? '' });
        }
      }
      // Match "annotation:" or "Annotation:" lines
      const annoMatch = text.match(/^\s*(?:annotation|tag)\s*:\s*(.+)/i);
      if (annoMatch) {
        const key = `anno:${annoMatch[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ type: 'annotation', description: annoMatch[1] });
        }
      }
    }
    return result;
  }, [outputLines]);

  return (
    <ScrollArea className="h-full text-xs">
      {annotations.length === 0 ? (
        <EmptyState title="No annotations found" />
      ) : (
        <div>
          {annotations.map((anno) => (
            <div
              key={`${anno.type}\u0000${anno.description}`}
              className="border-border/30 flex items-start gap-2 border-b px-3 py-1.5"
            >
              <Badge size="xxs" variant="outline" className="shrink-0">
                @{anno.type}
              </Badge>
              {anno.description && (
                <span className="text-muted-foreground">{anno.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
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

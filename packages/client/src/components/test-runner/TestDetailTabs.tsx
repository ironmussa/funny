import type {
  TestNetworkEntry,
  WSTestActionData,
  WSTestConsoleData,
  WSTestErrorData,
} from '@funny/shared';
import AnsiToHtml from 'ansi-to-html';
import {
  AlertTriangle,
  Crosshair,
  FileCode,
  Globe,
  Loader2,
  Paperclip,
  Phone,
  ScrollText,
  Tag,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { CodeViewer } from '@/components/ui/code-viewer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

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
function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '-';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const CONSOLE_LEVEL_STYLES: Record<string, string> = {
  error: 'text-red-500',
  warn: 'text-yellow-500',
  info: 'text-blue-400',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
  log: '',
};

const CONSOLE_LEVEL_ICONS: Record<string, string> = {
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

  const ansiConverter = useMemo(
    () =>
      new AnsiToHtml({
        fg: getCssVar('--foreground'),
        bg: getCssVar('--background'),
        newline: false,
        escapeXML: true,
      }),
    [],
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
    <div
      ref={logRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto px-3 py-1 font-mono text-xs"
    >
      {outputLines.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground">
          Test output will appear here...
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
          {outputLines.map((line, i) => (
            <div
              key={i}
              className={cn(line.stream === 'stderr' ? 'text-destructive' : '')}
              dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(line.line) }}
            />
          ))}
        </pre>
      )}
    </div>
  );
}

// ─── Tab: Console ──────────────────────────────────────────

function ConsoleTab({ entries }: { entries: WSTestConsoleData[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

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
    <div ref={ref} onScroll={handleScroll} className="h-full overflow-y-auto font-mono text-xs">
      {entries.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground">
          Browser console messages will appear here...
        </div>
      ) : (
        <div>
          {entries.map((entry, i) => (
            <div
              key={i}
              className={cn(
                'flex items-start gap-2 border-b border-border/30 px-3 py-1',
                CONSOLE_LEVEL_STYLES[entry.level] ?? '',
              )}
            >
              <span className="mt-0.5 w-3 shrink-0 text-center font-bold opacity-60">
                {CONSOLE_LEVEL_ICONS[entry.level] ?? '>'}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{entry.text}</span>
              {entry.url && (
                <span className="shrink-0 text-muted-foreground" title={entry.url}>
                  {shortenUrl(entry.url)}
                  {entry.line != null ? `:${entry.line}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Errors ───────────────────────────────────────────

function ErrorsTab({ entries }: { entries: WSTestErrorData[] }) {
  return (
    <div className="h-full overflow-y-auto font-mono text-xs">
      {entries.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground">No errors captured</div>
      ) : (
        <div>
          {entries.map((entry, i) => (
            <div key={i} className="border-b border-border/30 px-3 py-2">
              <div className="flex items-start gap-2 text-red-500">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="whitespace-pre-wrap break-all">{entry.message}</span>
              </div>
              {entry.source && (
                <div className="ml-5 mt-1 text-muted-foreground">
                  {entry.source}
                  {entry.line != null ? `:${entry.line}` : ''}
                  {entry.column != null ? `:${entry.column}` : ''}
                </div>
              )}
              {entry.stack && (
                <pre className="ml-5 mt-1 whitespace-pre-wrap text-muted-foreground/80">
                  {entry.stack}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Network ──────────────────────────────────────────

type NetworkFilter = 'All' | 'Fetch' | 'HTML' | 'JS' | 'CSS' | 'Font' | 'Image';
const NETWORK_FILTERS: NetworkFilter[] = ['All', 'Fetch', 'HTML', 'JS', 'CSS', 'Font', 'Image'];

/** Map CDP resource types to our filter categories */
function matchesNetworkFilter(entry: TestNetworkEntry, filter: NetworkFilter): boolean {
  if (filter === 'All') return true;
  const type = (entry.resourceType ?? '').toLowerCase();
  const mime = (entry.mimeType ?? '').toLowerCase();
  const url = entry.url.toLowerCase();
  switch (filter) {
    case 'Fetch':
      return type === 'fetch' || type === 'xhr' || type === 'xmlhttprequest';
    case 'HTML':
      return type === 'document' || mime.includes('html');
    case 'JS':
      return type === 'script' || mime.includes('javascript');
    case 'CSS':
      return type === 'stylesheet' || mime.includes('css');
    case 'Font':
      return type === 'font' || mime.includes('font') || /\.(woff2?|ttf|otf|eot)/.test(url);
    case 'Image':
      return type === 'image' || mime.includes('image');
    default:
      return true;
  }
}

function NetworkTab({ entries }: { entries: TestNetworkEntry[] }) {
  const [filter, setFilter] = useState<NetworkFilter>('All');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = entries;
    if (filter !== 'All') {
      result = result.filter((e) => matchesNetworkFilter(e, filter));
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((e) => e.url.toLowerCase().includes(q));
    }
    return result;
  }, [entries, filter, search]);

  const selectedEntry = useMemo(
    () => (selectedId ? (entries.find((e) => e.id === selectedId) ?? null) : null),
    [entries, selectedId],
  );

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Filter toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <input
          type="text"
          placeholder="Filter network"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mr-2 h-6 w-40 rounded border bg-transparent px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          data-testid="network-filter-input"
        />
        {NETWORK_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded px-2 py-0.5 text-xs transition-colors',
              filter === f
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            data-testid={`network-filter-${f.toLowerCase()}`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Split: request list + detail panel */}
      <div className="flex min-h-0 flex-1">
        {/* Request list */}
        <div
          className={cn(
            'min-h-0 overflow-y-auto border-r',
            selectedEntry ? 'w-[280px] shrink-0' : 'flex-1',
          )}
        >
          {filtered.length === 0 ? (
            <div className="py-4 text-center text-muted-foreground">
              {entries.length === 0
                ? 'Network requests will appear here...'
                : 'No matching requests'}
            </div>
          ) : selectedEntry ? (
            /* Compact name-only list when detail is open */
            <div className="font-mono">
              <div className="sticky top-0 border-b bg-muted/80 px-3 py-1 font-medium text-muted-foreground">
                Name
              </div>
              {filtered.map((entry) => (
                <div
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    'cursor-pointer truncate border-b border-border/20 px-3 py-1 hover:bg-muted/30',
                    entry.id === selectedId && 'bg-primary/10 text-primary',
                    entry.failed && 'text-red-500',
                    entry.status && entry.status >= 400 && 'text-red-500',
                  )}
                  title={entry.url}
                  data-testid={`network-row-${entry.id}`}
                >
                  {getUrlName(entry.url)}
                </div>
              ))}
            </div>
          ) : (
            /* Full table when no detail selected */
            <table className="w-full font-mono">
              <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1 font-medium">Status</th>
                  <th className="px-3 py-1 font-medium">Method</th>
                  <th className="px-3 py-1 font-medium">URL</th>
                  <th className="px-3 py-1 font-medium">Type</th>
                  <th className="px-3 py-1 text-right font-medium">Size</th>
                  <th className="px-3 py-1 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                    className={cn(
                      'cursor-pointer border-b border-border/20 hover:bg-muted/30',
                      entry.failed && 'text-red-500',
                      entry.status && entry.status >= 400 && 'text-red-500',
                    )}
                    data-testid={`network-row-${entry.id}`}
                  >
                    <td className="px-3 py-1">
                      <StatusBadge
                        status={entry.status}
                        failed={entry.failed}
                        errorText={entry.errorText}
                      />
                    </td>
                    <td className="px-3 py-1 text-muted-foreground">{entry.method}</td>
                    <td className="max-w-[300px] truncate px-3 py-1" title={entry.url}>
                      {shortenUrl(entry.url)}
                    </td>
                    <td className="px-3 py-1 text-muted-foreground">{entry.resourceType ?? '-'}</td>
                    <td className="px-3 py-1 text-right text-muted-foreground">
                      {formatSize(entry.size)}
                    </td>
                    <td className="px-3 py-1 text-right text-muted-foreground">
                      {formatDuration(entry.duration)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        {selectedEntry && (
          <NetworkDetailPanel entry={selectedEntry} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
}

function getUrlName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url.split('/').pop() || url;
  }
}

function StatusBadge({
  status,
  failed,
  errorText,
}: {
  status?: number;
  failed?: boolean;
  errorText?: string;
}) {
  if (failed) return <span title={errorText}>ERR</span>;
  if (!status) return <span className="text-muted-foreground">...</span>;
  return (
    <span
      className={cn(
        status >= 200 && status < 300 && 'text-green-500',
        status >= 300 && status < 400 && 'text-yellow-500',
        status >= 400 && 'text-red-500',
      )}
    >
      {status}
    </span>
  );
}

// ─── Network Detail Panel ─────────────────────────────────

type DetailTab = 'headers' | 'payload' | 'response';

function NetworkDetailPanel({ entry, onClose }: { entry: TestNetworkEntry; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>('headers');

  const handleCopy = () => {
    const curl = `curl '${entry.url}'${entry.method !== 'GET' ? ` -X ${entry.method}` : ''}${
      entry.requestHeaders
        ? Object.entries(entry.requestHeaders)
            .map(([k, v]) => ` -H '${k}: ${v}'`)
            .join('')
        : ''
    }${entry.postData ? ` --data-raw '${entry.postData}'` : ''}`;
    navigator.clipboard.writeText(curl).catch(() => {});
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="network-detail-panel">
      {/* Detail tabs header */}
      <div className="flex items-center justify-between border-b px-2 py-1">
        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="network-detail-close"
          >
            &times;
          </button>
          {(['headers', 'payload', 'response'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded px-2 py-0.5 capitalize transition-colors',
                tab === t
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`network-detail-tab-${t}`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="network-copy-request"
        >
          Copy request
        </button>
      </div>

      {/* Detail content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono">
        {tab === 'headers' && <HeadersDetail entry={entry} />}
        {tab === 'payload' && <PayloadDetail entry={entry} />}
        {tab === 'response' && <ResponseDetail entry={entry} />}
      </div>
    </div>
  );
}

function HeadersDetail({ entry }: { entry: TestNetworkEntry }) {
  const [generalOpen, setGeneralOpen] = useState(true);
  const [reqOpen, setReqOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);

  const reqHeaders = entry.requestHeaders ? Object.entries(entry.requestHeaders) : [];
  const resHeaders = entry.responseHeaders ? Object.entries(entry.responseHeaders) : [];

  return (
    <div className="space-y-1">
      {/* General */}
      <CollapsibleSection
        title="General"
        open={generalOpen}
        onToggle={() => setGeneralOpen(!generalOpen)}
      >
        <HeaderRow label="URL" value={entry.url} />
        <HeaderRow label="Method" value={entry.method} />
        <HeaderRow
          label="Status Code"
          value={
            entry.failed
              ? 'Failed'
              : entry.status
                ? `${entry.status} ${entry.statusText ?? ''}`
                : 'Pending'
          }
          statusDot={entry.status}
        />
        <HeaderRow label="Start" value={formatStartTime(entry.startTime)} />
        <HeaderRow label="Duration" value={formatDuration(entry.duration)} />
      </CollapsibleSection>

      {/* Request Headers */}
      <CollapsibleSection
        title={`Request Headers${reqHeaders.length > 0 ? ` \u00d7 ${reqHeaders.length}` : ''}`}
        open={reqOpen}
        onToggle={() => setReqOpen(!reqOpen)}
      >
        {reqHeaders.length > 0 ? (
          reqHeaders.map(([k, v]) => <HeaderRow key={k} label={k} value={v} />)
        ) : (
          <div className="py-1 text-muted-foreground">No request headers captured</div>
        )}
      </CollapsibleSection>

      {/* Response Headers */}
      <CollapsibleSection
        title={`Response Headers${resHeaders.length > 0 ? ` \u00d7 ${resHeaders.length}` : ''}`}
        open={resOpen}
        onToggle={() => setResOpen(!resOpen)}
      >
        {resHeaders.length > 0 ? (
          resHeaders.map(([k, v]) => <HeaderRow key={k} label={k} value={v} />)
        ) : (
          <div className="py-1 text-muted-foreground">No response headers captured</div>
        )}
      </CollapsibleSection>
    </div>
  );
}

function formatStartTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function parseQueryString(url: string): [string, string][] {
  try {
    const u = new URL(url);
    return Array.from(u.searchParams.entries());
  } catch {
    return [];
  }
}

function PayloadDetail({ entry }: { entry: TestNetworkEntry }) {
  const [queryOpen, setQueryOpen] = useState(true);
  const [bodyOpen, setBodyOpen] = useState(true);

  const queryParams = useMemo(() => parseQueryString(entry.url), [entry.url]);
  const hasBody = !!entry.postData;

  if (queryParams.length === 0 && !hasBody) {
    return <div className="py-4 text-center text-muted-foreground">No payload data</div>;
  }

  // Format body with line numbers
  const bodyLines = useMemo(() => {
    if (!entry.postData) return [];
    let text = entry.postData;
    try {
      text = JSON.stringify(JSON.parse(entry.postData), null, 2);
    } catch {
      // not JSON, show raw
    }
    return text.split('\n');
  }, [entry.postData]);

  return (
    <div className="space-y-1">
      {queryParams.length > 0 && (
        <CollapsibleSection
          title={`Query String Parameters \u00d7 ${queryParams.length}`}
          open={queryOpen}
          onToggle={() => setQueryOpen(!queryOpen)}
        >
          {queryParams.map(([k, v], i) => (
            <HeaderRow key={`${k}-${i}`} label={k} value={v} />
          ))}
        </CollapsibleSection>
      )}

      {hasBody && (
        <CollapsibleSection
          title="Request Body"
          open={bodyOpen}
          onToggle={() => setBodyOpen(!bodyOpen)}
        >
          <div className="overflow-x-auto rounded bg-muted/30">
            <pre className="whitespace-pre text-xs">
              {bodyLines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="w-8 shrink-0 select-none pr-2 text-right text-muted-foreground/50">
                    {i + 1}
                  </span>
                  <span className="break-all">{line}</span>
                </div>
              ))}
            </pre>
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function ResponseDetail({ entry }: { entry: TestNetworkEntry }) {
  // All hooks must be called unconditionally (React rules of hooks)
  const { isJson, lines } = useMemo(() => {
    if (!entry.responseBody || entry.responseBodyBase64) {
      return { formatted: '', isJson: false, lines: [] as string[] };
    }
    try {
      const f = JSON.stringify(JSON.parse(entry.responseBody), null, 2);
      return { formatted: f, isJson: true, lines: f.split('\n') };
    } catch {
      return {
        formatted: entry.responseBody,
        isJson: false,
        lines: entry.responseBody.split('\n'),
      };
    }
  }, [entry.responseBody, entry.responseBodyBase64]);

  if (!entry.responseBody) {
    return (
      <div className="py-4 text-center text-muted-foreground">
        {entry.status ? 'Response body not captured' : 'Waiting for response...'}
      </div>
    );
  }

  // Image preview for base64-encoded image responses
  if (entry.responseBodyBase64) {
    const isImage = entry.mimeType?.startsWith('image/');
    if (isImage) {
      return (
        <div className="flex flex-col items-center gap-2 py-4">
          <img
            src={`data:${entry.mimeType};base64,${entry.responseBody}`}
            alt="Response preview"
            className="max-h-[400px] max-w-full rounded border object-contain"
          />
          <span className="text-muted-foreground">
            {entry.mimeType} - {formatSize(entry.size)}
          </span>
        </div>
      );
    }
    return (
      <div className="py-4 text-center text-muted-foreground">
        Binary response ({entry.mimeType ?? 'unknown type'} - {formatSize(entry.size)})
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded bg-muted/30">
      <pre className="whitespace-pre text-xs">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-8 shrink-0 select-none pr-2 text-right text-muted-foreground/50">
              {i + 1}
            </span>
            <span className={cn('break-all', isJson && 'text-foreground')}>{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded-sm bg-muted/50 px-2 py-1.5 font-semibold text-foreground hover:bg-muted"
      >
        <span className="w-4 text-center text-muted-foreground">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
    </div>
  );
}

function HeaderRow({
  label,
  value,
  statusDot,
}: {
  label: string;
  value: string;
  statusDot?: number;
}) {
  return (
    <div className="flex gap-4 py-0.5">
      <span className="w-[160px] shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">
        {statusDot != null && (
          <span
            className={cn(
              'mr-1.5 inline-block h-2 w-2 rounded-full',
              statusDot >= 200 && statusDot < 300 && 'bg-green-500',
              statusDot >= 300 && statusDot < 400 && 'bg-yellow-500',
              statusDot >= 400 && 'bg-red-500',
              !statusDot && 'bg-muted-foreground',
            )}
          />
        )}
        {value}
      </span>
    </div>
  );
}

// ─── Tab: Source ───────────────────────────────────────────

function SourceTab({
  activeFile,
  projectPath,
}: {
  activeFile: string | null;
  projectPath: string | undefined;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFile = useRef<string | null>(null);

  useEffect(() => {
    if (!activeFile || !projectPath) {
      setCode(null);
      setError(null);
      loadedFile.current = null;
      return;
    }

    const fullPath = `${projectPath}/${activeFile}`;
    if (loadedFile.current === fullPath) return;

    loadedFile.current = fullPath;
    setLoading(true);
    setError(null);

    api.readFile(fullPath).then((result) => {
      if (result.isOk()) {
        setCode(result.value.content);
      } else {
        setError('Failed to load file');
      }
      setLoading(false);
    });
  }, [activeFile, projectPath]);

  const language = useMemo(() => {
    if (!activeFile) return 'typescript';
    const ext = activeFile.split('.').pop() ?? '';
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'js' || ext === 'jsx') return 'javascript';
    return 'typescript';
  }, [activeFile]);

  if (!activeFile) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Run a test to view its source
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (!code) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No source available
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="border-b px-3 py-1 text-xs text-muted-foreground">{activeFile}</div>
      <CodeViewer code={code} language={language} maxHeight="none" className="h-full" />
    </div>
  );
}

// ─── Tab: Call ─────────────────────────────────────────────

/** Regex to match Playwright action lines from --reporter=line output */
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
        text.includes('page.goto') ||
        text.includes('page.click') ||
        text.includes('page.fill') ||
        text.includes('page.type') ||
        text.includes('page.press') ||
        text.includes('page.waitFor') ||
        text.includes('locator.') ||
        text.includes('expect(') ||
        text.includes('navigating to') ||
        text.includes('waiting for') ||
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
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Playwright actions will appear here during test execution...
      </div>
    );
  }

  return (
    <div ref={ref} onScroll={handleScroll} className="h-full overflow-y-auto font-mono text-xs">
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
                <span className="ml-2 text-muted-foreground">
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
          {parsedActions.map((action, i) => (
            <div
              key={i}
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
    </div>
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
    <div className="h-full overflow-y-auto text-xs">
      {annotations.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground">No annotations found</div>
      ) : (
        <div>
          {annotations.map((anno, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-border/30 px-3 py-1.5">
              <Badge variant="outline" className="shrink-0 text-[10px]">
                @{anno.type}
              </Badge>
              {anno.description && (
                <span className="text-muted-foreground">{anno.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Placeholder Tab ───────────────────────────────────────

function PlaceholderTab({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
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
        <TabTrigger value="locator" icon={<Crosshair className="h-3.5 w-3.5" />} label="Locator" />
        <TabTrigger value="source" icon={<FileCode className="h-3.5 w-3.5" />} label="Source" />
        <TabTrigger value="call" icon={<Phone className="h-3.5 w-3.5" />} label="Call" />
        <TabTrigger value="log" icon={<ScrollText className="h-3.5 w-3.5" />} label="Log" />
        <TabTrigger
          value="errors"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Errors"
          count={errorEntries.length}
        />
        <TabTrigger
          value="console"
          icon={<Terminal className="h-3.5 w-3.5" />}
          label="Console"
          count={consoleEntries.length}
        />
        <TabTrigger
          value="network"
          icon={<Globe className="h-3.5 w-3.5" />}
          label="Network"
          count={networkEntries.length}
        />
        <TabTrigger
          value="attachments"
          icon={<Paperclip className="h-3.5 w-3.5" />}
          label="Attachments"
        />
        <TabTrigger
          value="annotations"
          icon={<Tag className="h-3.5 w-3.5" />}
          label="Annotations"
        />
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
      className="gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
      data-testid={`test-detail-tab-${value}`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <Badge variant="secondary" className="ml-1 h-4 min-w-[16px] px-1 text-[10px]">
          {count}
        </Badge>
      )}
    </TabsTrigger>
  );
}

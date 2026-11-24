import type { TestNetworkEntry } from '@funny/shared';
import { useMemo, useState } from 'react';

import {
  formatDuration,
  formatSize,
  withStableOccurrenceKeys,
} from '@/components/test-runner/detail-tabs/shared';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// ─── Network Detail Panel ─────────────────────────────────

type DetailTab = 'headers' | 'payload' | 'response';

export function NetworkDetailPanel({
  entry,
  onClose,
}: {
  entry: TestNetworkEntry;
  onClose: () => void;
}) {
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
            className="text-muted-foreground hover:bg-muted hover:text-foreground mr-1 rounded p-0.5"
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
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1 rounded px-2 py-0.5"
          data-testid="network-copy-request"
        >
          Copy request
        </button>
      </div>

      {/* Detail content */}
      <ScrollArea className="min-h-0 flex-1 font-mono">
        <div className="px-4 py-2">
          {tab === 'headers' && <HeadersDetail entry={entry} />}
          {tab === 'payload' && <PayloadDetail entry={entry} />}
          {tab === 'response' && <ResponseDetail entry={entry} />}
        </div>
      </ScrollArea>
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
          <div className="text-muted-foreground py-1">No request headers captured</div>
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
          <div className="text-muted-foreground py-1">No response headers captured</div>
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

/** Pretty-prints a JSON body; anything else is shown raw. */
function formatBody(postData: string): string {
  try {
    return JSON.stringify(JSON.parse(postData), null, 2);
  } catch {
    return postData;
  }
}

function PayloadDetail({ entry }: { entry: TestNetworkEntry }) {
  const [queryOpen, setQueryOpen] = useState(true);
  const [bodyOpen, setBodyOpen] = useState(true);

  const queryParams = useMemo(() => parseQueryString(entry.url), [entry.url]);
  const keyedQueryParams = useMemo(
    () => withStableOccurrenceKeys(queryParams, ([key, value]) => `${key}\u0000${value}`),
    [queryParams],
  );
  const hasBody = !!entry.postData;

  // Format body with line numbers
  const bodyLines = useMemo(() => {
    if (!entry.postData) return [];
    return withStableOccurrenceKeys(formatBody(entry.postData).split('\n'), (line) => line);
  }, [entry.postData]);

  if (queryParams.length === 0 && !hasBody) {
    return <EmptyState fill={false} title="No payload data" />;
  }

  return (
    <div className="space-y-1">
      {queryParams.length > 0 && (
        <CollapsibleSection
          title={`Query String Parameters \u00d7 ${queryParams.length}`}
          open={queryOpen}
          onToggle={() => setQueryOpen(!queryOpen)}
        >
          {keyedQueryParams.map(({ key, value: [name, value] }) => (
            <HeaderRow key={key} label={name} value={value} />
          ))}
        </CollapsibleSection>
      )}

      {hasBody && (
        <CollapsibleSection
          title="Request Body"
          open={bodyOpen}
          onToggle={() => setBodyOpen(!bodyOpen)}
        >
          <div className="bg-muted/30 overflow-x-auto rounded">
            <pre className="text-xs whitespace-pre">
              {bodyLines.map(({ key, value: line }, lineIndex) => (
                <div key={key} className="flex">
                  <span className="text-muted-foreground/50 w-8 shrink-0 pr-2 text-right select-none">
                    {lineIndex + 1}
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
      return { formatted: '', isJson: false, lines: [] as Array<{ key: string; value: string }> };
    }
    try {
      const f = JSON.stringify(JSON.parse(entry.responseBody), null, 2);
      return {
        formatted: f,
        isJson: true,
        lines: withStableOccurrenceKeys(f.split('\n'), (line) => line),
      };
    } catch {
      return {
        formatted: entry.responseBody,
        isJson: false,
        lines: withStableOccurrenceKeys(entry.responseBody.split('\n'), (line) => line),
      };
    }
  }, [entry.responseBody, entry.responseBodyBase64]);

  if (!entry.responseBody) {
    return (
      <div className="text-muted-foreground py-4 text-center">
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
      <div className="text-muted-foreground py-4 text-center">
        Binary response ({entry.mimeType ?? 'unknown type'} - {formatSize(entry.size)})
      </div>
    );
  }

  return (
    <div className="bg-muted/30 overflow-x-auto rounded">
      <pre className="text-xs whitespace-pre">
        {lines.map(({ key, value: line }, lineIndex) => (
          <div key={key} className="flex">
            <span className="text-muted-foreground/50 w-8 shrink-0 pr-2 text-right select-none">
              {lineIndex + 1}
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
        className="bg-muted/50 text-foreground hover:bg-muted flex w-full items-center gap-1 rounded-sm px-2 py-1.5 font-semibold"
      >
        <span className="text-muted-foreground w-4 text-center">{open ? '▾' : '▸'}</span>
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
      <span className="text-muted-foreground w-[160px] shrink-0">{label}</span>
      <span className="min-w-0 break-all">
        {statusDot != null && (
          <span
            className={cn(
              'mr-1.5 inline-block size-2 rounded-full',
              statusDot >= 200 && statusDot < 300 && 'bg-status-success',
              statusDot >= 300 && statusDot < 400 && 'bg-status-warning',
              statusDot >= 400 && 'bg-status-error',
              !statusDot && 'bg-muted-foreground',
            )}
          />
        )}
        {value}
      </span>
    </div>
  );
}

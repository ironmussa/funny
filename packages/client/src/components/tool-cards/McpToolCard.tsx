import { threadBrowserSessionId } from '@funny/shared';
import { CircleAlert, ChevronRight, Globe, Plug } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { getUrlThreadId } from '@/stores/thread-store';

import { ToolValue } from './GenericToolCard';
import {
  formatDurationMs,
  getMcpCodeInput,
  getMcpSummary,
  isBrowserTool,
  mcpResultPreview,
  mcpToolTitle,
  parseMcpResult,
  type McpResultPart,
  type McpToolName,
} from './mcp-tool';
import { ToolContentArea } from './MobileContentPreview';

interface Props {
  mcp: McpToolName;
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  displayTime: string | null;
}

/**
 * Card for MCP tool calls (`mcp__<server>__<tool>`): the server and tool in
 * the header with the call's title, code inputs highlighted, and the MCP
 * result envelope rendered as its content (markdown, images, resources)
 * rather than raw JSON — the raw output stays one click away.
 */
export function McpToolCard({ mcp, parsed, output, hideLabel, displayTime }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);

  const summary = useMemo(() => getMcpSummary(parsed, mcp), [parsed, mcp]);
  const codeInput = useMemo(() => getMcpCodeInput(parsed, mcp.tool), [parsed, mcp.tool]);
  const result = useMemo(() => parseMcpResult(output), [output]);
  const otherInputs = useMemo(
    () =>
      Object.entries(parsed).filter(
        ([key, value]) =>
          key !== codeInput?.key && key !== summary?.key && value !== undefined && value !== null,
      ),
    [parsed, codeInput, summary],
  );
  const preview = useMemo(() => {
    if (expanded || !output) return null;
    if (result) return mcpResultPreview(result);
    const line = output
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    return line ? (line.length > 120 ? line.slice(0, 120) + '…' : line) : null;
  }, [expanded, output, result]);
  const resultText = useMemo(
    () =>
      result
        ? result.parts
            .map((p) => (p.kind === 'text' ? p.text : p.kind === 'resource' ? p.uri : ''))
            .filter(Boolean)
            .join('\n\n')
        : (output ?? ''),
    [result, output],
  );

  const isError = result?.isError ?? false;
  const label = mcpToolTitle(mcp, t);

  return (
    <div
      className={cn(
        'max-w-full overflow-hidden rounded-lg border text-sm',
        isError ? 'border-destructive/50' : 'border-border',
      )}
      data-testid={`mcp-tool-card-${mcp.server}-${mcp.tool}`}
    >
      <div className="hover:bg-accent/30 relative w-full rounded-md text-left">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          className="absolute inset-0 z-0 w-full cursor-pointer rounded-md"
          onClick={() => setExpanded(!expanded)}
          data-testid="mcp-tool-card-toggle"
        />
        <div className="pointer-events-none relative z-10 flex w-full items-center gap-2 overflow-hidden px-3 py-1.5 text-left text-xs">
          <ChevronRight
            className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
          />
          {!hideLabel && (
            <>
              <Plug className="icon-xs text-muted-foreground shrink-0" />
              <span className="text-foreground shrink-0 font-mono font-medium">{label}</span>
            </>
          )}
          {summary && (
            <span className="text-muted-foreground min-w-0 truncate">{summary.text}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {isError && (
              <CircleAlert
                className="icon-xs text-destructive"
                aria-label={t('tools.mcpError')}
                data-testid="mcp-tool-card-error"
              />
            )}
            {result?.durationMs != null && (
              <span className="text-muted-foreground/70 text-[10px] tabular-nums">
                {formatDurationMs(result.durationMs)}
              </span>
            )}
            {displayTime && (
              <span className="text-muted-foreground/50 text-[10px] tabular-nums">
                {displayTime}
              </span>
            )}
          </span>
        </div>
        {preview && (
          <div className="pointer-events-none relative z-10 -mt-0.5 px-3 pb-1.5">
            <p
              className={cn(
                'truncate font-mono text-xs leading-tight',
                isError ? 'text-destructive/80' : 'text-muted-foreground/70',
              )}
            >
              → {preview}
            </p>
          </div>
        )}
      </div>

      {expanded && (
        <ToolContentArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}
        >
          <div className="space-y-2 px-3 pt-1.5 pb-2">
            {isBrowserTool(mcp) && <ShowInBrowserPanelButton />}
            {codeInput && (
              <Section label={codeInput.key}>
                <CodeBlock code={codeInput.code} language={codeInput.language} />
              </Section>
            )}
            {otherInputs.length > 0 && (
              <Section label={t('tools.input')}>
                <dl className="space-y-1">
                  {otherInputs.map(([key, value]) => (
                    <div key={key} className="flex min-w-0 gap-2">
                      <dt className="text-muted-foreground shrink-0 font-mono text-xs">{key}</dt>
                      <dd className="min-w-0 flex-1">
                        <ToolValue value={value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>
            )}
            {output && (
              <Section
                label={isError ? t('tools.mcpError') : t('tools.output')}
                tone={isError ? 'error' : undefined}
                actions={
                  <>
                    {result && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setRaw(!raw)}
                        data-testid="mcp-tool-card-raw-toggle"
                      >
                        {raw ? t('tools.formatted') : t('tools.raw')}
                      </Button>
                    )}
                    <CopyButton
                      value={raw || !result ? output : resultText}
                      label={t('tools.copy')}
                      data-testid="mcp-tool-card-copy"
                    />
                  </>
                }
              >
                {result && !raw ? (
                  <div className="space-y-2">
                    {result.parts.map((part, i) => (
                      <ResultPart key={i} part={part} isError={isError} />
                    ))}
                    {result.structured != null && <ToolValue value={result.structured} />}
                  </div>
                ) : (
                  <ToolValue value={raw ? prettyJson(output) : output} />
                )}
              </Section>
            )}
          </div>
        </ToolContentArea>
      )}
    </div>
  );
}

/** Open the browser panel on the active thread's (agent-shared) session. */
function ShowInBrowserPanelButton() {
  const { t } = useTranslation();
  const handleAgentOpened = useBrowserPanelStore((s) => s.handleAgentOpened);
  const threadId = getUrlThreadId();
  if (!threadId) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        useBrowserPanelStore.setState({ open: true });
        handleAgentOpened(threadBrowserSessionId(threadId), threadId, threadId);
      }}
      data-testid="mcp-tool-card-show-in-browser-panel"
    >
      <Globe className="icon-xs" />
      {t('tools.mcp.showInBrowserPanel')}
    </Button>
  );
}

function Section({
  label,
  tone,
  actions,
  children,
}: {
  label: string;
  tone?: 'error';
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-1">
        <div
          className={cn(
            'text-xs font-semibold uppercase',
            tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {label}
        </div>
        {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
      </div>
      <div
        className={cn(
          'bg-background/80 overflow-x-auto rounded border px-2.5 py-1.5',
          tone === 'error' ? 'border-destructive/40' : 'border-border/40',
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ResultPart({ part, isError }: { part: McpResultPart; isError: boolean }) {
  if (part.kind === 'image') {
    return <img src={part.src} alt={part.mimeType} className="max-h-80 max-w-full rounded" />;
  }
  if (part.kind === 'resource') {
    return (
      <div className="space-y-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="text-muted-foreground truncate font-mono text-xs">{part.uri}</div>
          </TooltipTrigger>
          <TooltipContent>{part.uri}</TooltipContent>
        </Tooltip>
        {part.text && <ToolValue value={part.text} />}
      </div>
    );
  }
  if (part.markdown && !isError) {
    return (
      <div className="text-foreground/80 text-sm">
        <MessageContent content={part.text} />
      </div>
    );
  }
  return (
    <pre
      className={cn(
        'font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
        isError ? 'text-destructive/90' : 'text-foreground/80',
      )}
    >
      {part.text}
    </pre>
  );
}

function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null);

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    ensureHighlight(code, language).then((ok) => {
      if (cancelled || !ok) return;
      setHighlighted({ code, html: highlightCode(code, language) });
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (language && highlighted?.code === code) {
    return (
      <pre className="code-viewer hljs text-foreground m-0 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    );
  }
  return (
    <pre className="text-foreground/80 m-0 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function prettyJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

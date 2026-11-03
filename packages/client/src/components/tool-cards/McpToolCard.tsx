import { threadBrowserSessionId } from '@funny/shared';
import { CircleAlert, ChevronRight, Globe, Plug } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { MediaPreview } from '@/components/MediaPreview';
import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ensureHighlight, highlightCode } from '@/hooks/use-highlight';
import { toRawFileSrc } from '@/lib/raw-file-src';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { getUrlThreadId } from '@/stores/thread-store';

import { ToolValue } from './GenericToolCard';
import {
  browserRecordingPath,
  formatDurationMs,
  getMcpCodeInput,
  getMcpSummary,
  isBrowserTool,
  mcpResultPreview,
  mcpToolTitle,
  parseMcpResult,
  type McpResult,
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

/** First non-empty line of a non-MCP output, truncated for the collapsed row. */
function plainOutputPreview(output: string): string | null {
  const line = output
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}

/** Text a result carries (text parts and resource URIs), for copy and recordings. */
function resultTextOf(result: McpResult | null, output: string | undefined): string {
  if (!result) return output ?? '';
  return result.parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'resource' ? p.uri : ''))
    .filter(Boolean)
    .join('\n\n');
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
  const summary = useMemo(() => getMcpSummary(parsed, mcp), [parsed, mcp]);
  const codeInput = useMemo(() => getMcpCodeInput(parsed, mcp.tool), [parsed, mcp.tool]);
  const result = useMemo(() => parseMcpResult(output), [output]);
  const otherInputs = useMemo(
    () => otherMcpInputs(parsed, [codeInput?.key, summary?.key]),
    [parsed, codeInput, summary],
  );
  const preview = useMemo(() => {
    if (expanded || !output) return null;
    return result ? mcpResultPreview(result) : plainOutputPreview(output);
  }, [expanded, output, result]);
  const resultText = useMemo(() => resultTextOf(result, output), [result, output]);

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
      <McpToolCardHeader
        label={label}
        summaryText={summary?.text ?? null}
        preview={preview}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        hideLabel={hideLabel}
        isError={isError}
        durationMs={result?.durationMs ?? null}
        displayTime={displayTime}
      />

      {expanded && (
        <McpToolCardBody
          mcp={mcp}
          codeInput={codeInput}
          otherInputs={otherInputs}
          output={output}
          result={result}
          resultText={resultText}
          isError={isError}
        />
      )}
    </div>
  );
}

/** Inputs not already shown as the summary or the highlighted code block. */
function otherMcpInputs(
  parsed: Record<string, unknown>,
  shownKeys: (string | undefined)[],
): [string, unknown][] {
  return Object.entries(parsed).filter(
    ([key, value]) => !shownKeys.includes(key) && value !== undefined && value !== null,
  );
}

function McpToolCardBody({
  mcp,
  codeInput,
  otherInputs,
  output,
  result,
  resultText,
  isError,
}: {
  mcp: McpToolName;
  codeInput: ReturnType<typeof getMcpCodeInput>;
  otherInputs: [string, unknown][];
  output?: string;
  result: McpResult | null;
  resultText: string;
  isError: boolean;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  return (
    <ToolContentArea
      className="border-border/40 border-t"
      viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}
    >
      <div className="space-y-2 px-3 pt-1.5 pb-2">
        {isBrowserTool(mcp) && <ShowInBrowserPanelButton />}
        <BrowserRecordingPreview mcp={mcp} resultText={resultText} isError={isError} />
        {codeInput && (
          <Section label={codeInput.key}>
            <CodeBlock code={codeInput.code} language={codeInput.language} />
          </Section>
        )}
        {otherInputs.length > 0 && <McpInputList label={t('tools.input')} inputs={otherInputs} />}
        {output && (
          <McpOutputSection
            output={output}
            result={result}
            resultText={resultText}
            isError={isError}
            raw={raw}
            onToggleRaw={() => setRaw(!raw)}
          />
        )}
      </div>
    </ToolContentArea>
  );
}

function McpInputList({ label, inputs }: { label: string; inputs: [string, unknown][] }) {
  return (
    <Section label={label}>
      <dl className="space-y-1">
        {inputs.map(([key, value]) => (
          <div key={key} className="flex min-w-0 gap-2">
            <dt className="text-muted-foreground shrink-0 font-mono text-xs">{key}</dt>
            <dd className="min-w-0 flex-1">
              <ToolValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function McpToolCardMeta({
  isError,
  durationMs,
  displayTime,
}: {
  isError: boolean;
  durationMs: number | null;
  displayTime: string | null;
}) {
  const { t } = useTranslation();
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {isError && (
        <CircleAlert
          className="icon-xs text-destructive"
          aria-label={t('tools.mcpError')}
          data-testid="mcp-tool-card-error"
        />
      )}
      {durationMs != null && (
        <span className="text-muted-foreground/70 text-[10px] tabular-nums">
          {formatDurationMs(durationMs)}
        </span>
      )}
      {displayTime && (
        <span className="text-muted-foreground/50 text-[10px] tabular-nums">{displayTime}</span>
      )}
    </span>
  );
}

function McpToolCardPreview({ preview, isError }: { preview: string; isError: boolean }) {
  return (
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
  );
}

function McpToolCardHeader({
  label,
  summaryText,
  preview,
  expanded,
  onToggle,
  hideLabel,
  isError,
  durationMs,
  displayTime,
}: {
  label: string;
  summaryText: string | null;
  preview: string | null;
  expanded: boolean;
  onToggle: () => void;
  hideLabel?: boolean;
  isError: boolean;
  durationMs: number | null;
  displayTime: string | null;
}) {
  return (
    <div className="hover:bg-accent/30 relative w-full rounded-md text-left">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        className="absolute inset-0 z-0 w-full cursor-pointer rounded-md"
        onClick={onToggle}
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
        {summaryText && (
          <span className="text-muted-foreground min-w-0 truncate">{summaryText}</span>
        )}
        <McpToolCardMeta isError={isError} durationMs={durationMs} displayTime={displayTime} />
      </div>
      {preview && <McpToolCardPreview preview={preview} isError={isError} />}
    </div>
  );
}

/** Inline player for the MP4 a `browser_recording_stop` call saved. */
function BrowserRecordingPreview({
  mcp,
  resultText,
  isError,
}: {
  mcp: McpToolName;
  resultText: string;
  isError: boolean;
}) {
  const recording = isError ? null : browserRecordingPath(mcp, resultText);
  if (!recording) return null;
  return (
    <MediaPreview
      src={toRawFileSrc(recording)}
      name={recording.split('/').pop()}
      kind="video"
      className="max-h-80"
    />
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

function McpOutputSection({
  output,
  result,
  resultText,
  isError,
  raw,
  onToggleRaw,
}: {
  output: string;
  result: ReturnType<typeof parseMcpResult>;
  resultText: string;
  isError: boolean;
  raw: boolean;
  onToggleRaw: () => void;
}) {
  const { t } = useTranslation();
  const formattedResult = raw ? null : result;
  return (
    <Section
      label={isError ? t('tools.mcpError') : t('tools.output')}
      tone={isError ? 'error' : undefined}
      actions={
        <>
          {result && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onToggleRaw}
              data-testid="mcp-tool-card-raw-toggle"
            >
              {raw ? t('tools.formatted') : t('tools.raw')}
            </Button>
          )}
          <CopyButton
            value={formattedResult ? resultText : output}
            label={t('tools.copy')}
            data-testid="mcp-tool-card-copy"
          />
        </>
      }
    >
      {formattedResult ? (
        <FormattedMcpResult result={formattedResult} isError={isError} />
      ) : (
        <ToolValue value={raw ? prettyJson(output) : output} />
      )}
    </Section>
  );
}

function FormattedMcpResult({
  result,
  isError,
}: {
  result: NonNullable<ReturnType<typeof parseMcpResult>>;
  isError: boolean;
}) {
  return (
    <div className="space-y-2">
      {result.parts.map((part, i) => (
        <ResultPart key={i} part={part} isError={isError} />
      ))}
      {result.structured != null && <ToolValue value={result.structured} />}
    </div>
  );
}

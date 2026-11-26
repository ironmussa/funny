import { MessageContent } from '@/components/thread/MessageContent';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { McpResult, McpResultPart } from './mcp-tool';
import { ToolValue } from './ToolValue';

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

/** An MCP result's parts: text, images and resources, then its structured content. */
export function FormattedMcpResult({ result, isError }: { result: McpResult; isError: boolean }) {
  return (
    <div className="space-y-2">
      {result.parts.map((part, i) => (
        <ResultPart key={i} part={part} isError={isError} />
      ))}
      {result.structured != null && <ToolValue value={result.structured} />}
    </div>
  );
}

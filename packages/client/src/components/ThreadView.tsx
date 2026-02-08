import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';
import { GitCompare, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { PromptInput } from './PromptInput';
import { ToolCallCard } from './ToolCallCard';
import { StartupCommandsPopover } from './StartupCommandsPopover';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

function toVscodeUri(filePath: string): string {
  // Split off :lineNumber if present
  const match = filePath.match(/^(.+):(\d+)$/);
  const path = match ? match[1] : filePath;
  const line = match ? match[2] : null;
  const normalized = path.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `vscode://file${withLeadingSlash}${line ? ':' + line : ''}`;
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
    <ReactMarkdown
      components={{
        a: ({ href, children }) => {
          const text = String(children);
          const fileMatch = text.match(FILE_PATH_RE);
          if (fileMatch) {
            return (
              <a href={toVscodeUri(fileMatch[0])} className="text-primary hover:underline" title={`Open in VS Code: ${text}`}>
                {children}
              </a>
            );
          }
          return <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>;
        },
        code: ({ className, children, ...props }) => {
          const isBlock = className?.startsWith('language-');
          return isBlock
            ? <code className={cn('block bg-muted p-2 rounded text-xs overflow-x-auto', className)} {...props}>{children}</code>
            : <code className="bg-muted px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
        },
        pre: ({ children }) => <pre className="bg-muted rounded p-2 overflow-x-auto my-2">{children}</pre>,
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}

function NewThreadInput() {
  const navigate = useNavigate();
  const { newThreadProjectId, cancelNewThread, loadThreadsForProject } =
    useAppStore();

  const [creating, setCreating] = useState(false);

  const handleCreate = async (prompt: string, opts: { model: string; mode: string }, images?: any[]) => {
    if (!newThreadProjectId || creating) return;
    setCreating(true);

    try {
      const thread = await api.createThread({
        projectId: newThreadProjectId,
        title: prompt.slice(0, 200),
        mode: 'local',
        model: opts.model,
        permissionMode: opts.mode,
        prompt,
        images,
      });

      await loadThreadsForProject(newThreadProjectId);
      navigate(`/projects/${newThreadProjectId}/threads/${thread.id}`);
    } catch (e: any) {
      alert(e.message);
      setCreating(false);
    }
  };

  return (
    <>
      {/* Empty state area */}
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">What should the agent do?</p>
          <p className="text-xs mt-1">Describe the task and press Enter to start</p>
        </div>
      </div>

      <PromptInput
        onSubmit={handleCreate}
        loading={creating}
      />
    </>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function AgentResultCard({ status, cost, duration }: { status: 'completed' | 'failed'; cost: number; duration: number }) {
  const isSuccess = status === 'completed';

  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-xs flex items-center gap-3',
      isSuccess
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-red-500/30 bg-red-500/5'
    )}>
      {isSuccess ? (
        <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
      )}
      <span className={cn('font-medium', isSuccess ? 'text-green-500' : 'text-red-500')}>
        {isSuccess ? 'Task completed' : 'Task failed'}
      </span>
      <div className="flex items-center gap-3 ml-auto text-muted-foreground">
        {duration > 0 && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(duration)}
          </span>
        )}
      </div>
    </div>
  );
}

function ProjectHeader() {
  const { activeThread, selectedProjectId, setReviewPaneOpen, reviewPaneOpen } = useAppStore();

  if (!selectedProjectId) return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        {activeThread && (
          <>
            <h2 className="text-sm font-medium truncate">{activeThread.title}</h2>
            {activeThread.branch && (
              <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                {activeThread.branch}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <StartupCommandsPopover projectId={activeThread?.projectId ?? selectedProjectId} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setReviewPaneOpen(!reviewPaneOpen)}
              className={reviewPaneOpen ? 'text-primary' : 'text-muted-foreground'}
            >
              <GitCompare className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle review pane</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function ThreadView() {
  const { activeThread, selectedThreadId, selectedProjectId, newThreadProjectId } =
    useAppStore();
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [activeThread?.messages?.length]);


  // Show new thread input when a project's "+" was clicked
  if (newThreadProjectId && !selectedThreadId) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ProjectHeader />
        <NewThreadInput />
      </div>
    );
  }

  if (!selectedThreadId || !activeThread) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one</p>
            <p className="text-xs mt-1">Threads run Claude Code agents in parallel</p>
          </div>
        </div>
      </div>
    );
  }

  const handleSend = async (prompt: string, opts: { model: string; mode: string }, images?: any[]) => {
    if (sending) return;
    setSending(true);

    useAppStore.getState().appendOptimisticMessage(activeThread.id, prompt);

    try {
      await api.sendMessage(activeThread.id, prompt, { model: opts.model, permissionMode: opts.mode }, images);
    } catch (e: any) {
      console.error('Send failed:', e);
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    try {
      await api.stopThread(activeThread.id);
    } catch (e: any) {
      console.error('Stop failed:', e);
    }
  };

  const isRunning = activeThread.status === 'running';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <ProjectHeader />

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="mx-auto w-1/2 min-w-[320px] max-w-full space-y-3 overflow-hidden">
          {activeThread.initInfo && (
            <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">Model:</span>
                <span className="font-mono">{activeThread.initInfo.model}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium">CWD:</span>
                <span className="font-mono truncate">{activeThread.initInfo.cwd}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-medium shrink-0">Tools:</span>
                <span className="font-mono flex flex-wrap gap-1">
                  {activeThread.initInfo.tools.map((tool) => (
                    <span key={tool} className="bg-secondary px-1.5 py-0.5 rounded text-[10px]">
                      {tool}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}

          {activeThread.messages?.flatMap((msg) => [
            msg.content && (
              <div
                key={msg.id}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm w-fit max-w-full',
                  msg.role === 'user'
                    ? 'ml-auto bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground'
                )}
              >
                {msg.role !== 'user' && (
                  <span className="text-[10px] font-medium uppercase text-muted-foreground block mb-0.5">
                    {msg.role}
                  </span>
                )}
                {msg.images && msg.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.images.map((img: any, idx: number) => (
                      <img
                        key={idx}
                        src={`data:${img.source.media_type};base64,${img.source.data}`}
                        alt={`Attachment ${idx + 1}`}
                        className="max-h-40 rounded border border-border"
                      />
                    ))}
                  </div>
                )}
                {msg.role === 'user' ? (
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto">
                    {msg.content.trim()}
                  </pre>
                ) : (
                  <div className="text-xs leading-relaxed break-words overflow-x-auto">
                    <MessageContent content={msg.content.trim()} />
                  </div>
                )}
              </div>
            ),
            ...(msg.toolCalls?.map((tc: any) => (
              <ToolCallCard
                key={tc.id}
                name={tc.name}
                input={tc.input}
                output={tc.output}
                onRespond={tc.name === 'AskUserQuestion' ? (answer: string) => handleSend(answer, { model: '', mode: '' }) : undefined}
              />
            )) ?? []),
          ])}

          {isRunning && (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Agent is working...
            </div>
          )}

          {activeThread.resultInfo && !isRunning && (
            <AgentResultCard
              status={activeThread.resultInfo.status}
              cost={activeThread.resultInfo.cost}
              duration={activeThread.resultInfo.duration}
            />
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <PromptInput
        onSubmit={handleSend}
        onStop={handleStop}
        loading={sending}
        running={isRunning}
        placeholder="What do you want to do next?"
      />
    </div>
  );
}

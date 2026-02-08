import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  X,
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  GitCommit,
  Upload,
  GitPullRequest,
  FileCode,
  FilePlus,
  FileX,
} from 'lucide-react';
import type { FileDiff } from '@a-parallel/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

export function ReviewPane() {
  const { activeThread, setReviewPaneOpen } = useAppStore();
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const threadId = activeThread?.id;

  const refresh = async () => {
    if (!threadId) return;
    setLoading(true);
    try {
      const data = await api.getDiff(threadId);
      setDiffs(data);
      if (data.length > 0 && !selectedFile) {
        setSelectedFile(data[0].path);
      }
    } catch (e: any) {
      console.error('Failed to load diff:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [threadId]);

  const selectedDiff = diffs.find((d) => d.path === selectedFile);

  const handleStage = async (paths: string[]) => {
    if (!threadId) return;
    await api.stageFiles(threadId, paths);
    await refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    if (!threadId) return;
    await api.unstageFiles(threadId, paths);
    await refresh();
  };

  const handleRevert = async (paths: string[]) => {
    if (!threadId) return;
    if (!confirm(`Revert ${paths.join(', ')}? This cannot be undone.`)) return;
    await api.revertFiles(threadId, paths);
    await refresh();
  };

  const handleCommit = async () => {
    if (!threadId || !commitMsg.trim()) return;
    try {
      await api.commit(threadId, commitMsg);
      setCommitMsg('');
      await refresh();
    } catch (e: any) {
      alert(`Commit failed: ${e.message}`);
    }
  };

  const handlePush = async () => {
    if (!threadId) return;
    try {
      await api.push(threadId);
      alert('Pushed successfully');
    } catch (e: any) {
      alert(`Push failed: ${e.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Review</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={refresh}
                className="text-muted-foreground"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setReviewPaneOpen(false)}
          className="text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* File list */}
      <ScrollArea className="border-b border-border max-h-48">
        {diffs.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">No changes</p>
        ) : (
          diffs.map((f) => {
            const Icon = fileStatusIcons[f.status] || FileCode;
            return (
              <div
                key={f.path}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer transition-colors',
                  selectedFile === f.path
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50 text-muted-foreground'
                )}
                onClick={() => setSelectedFile(f.path)}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-1 truncate font-mono">{f.path}</span>
                <span className={cn('text-[10px]', f.staged ? 'text-green-400' : 'text-yellow-400')}>
                  {f.staged ? 'staged' : 'unstaged'}
                </span>
                <div className="flex gap-0.5">
                  {f.staged ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleUnstage([f.path]); }}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Unstage</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleStage([f.path]); }}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Stage</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); handleRevert([f.path]); }}
                        className="text-destructive"
                      >
                        <Undo2 className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Revert</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </ScrollArea>

      {/* Diff viewer */}
      <ScrollArea className="flex-1">
        {selectedDiff ? (
          selectedDiff.diff ? (
            <div
              className="diff-viewer text-xs"
              dangerouslySetInnerHTML={{
                __html: diff2html(selectedDiff.diff, {
                  outputFormat: 'line-by-line',
                  drawFileList: false,
                  matching: 'lines',
                } as any),
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground p-2">(binary file or no diff available)</p>
          )
        ) : (
          <p className="text-xs text-muted-foreground p-2">Select a file to view diff</p>
        )}
      </ScrollArea>

      {/* Git actions */}
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex gap-1.5">
          <input
            className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Commit message"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                onClick={handleCommit}
                disabled={!commitMsg.trim()}
              >
                <GitCommit className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Commit</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={handlePush}
          >
            <Upload className="h-3 w-3 mr-1" />
            Push
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={() => {
              const title = prompt('PR title:');
              if (!title || !threadId) return;
              api.createPR(threadId, title, '').then(() => alert('PR created')).catch((e: any) => alert(e.message));
            }}
          >
            <GitPullRequest className="h-3 w-3 mr-1" />
            Create PR
          </Button>
        </div>
      </div>
    </div>
  );
}

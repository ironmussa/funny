import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { useTerminalStore } from '@/stores/terminal-store';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Play, Plus, Pencil, Trash2, Terminal, X, Check, Square, Loader2 } from 'lucide-react';
import type { StartupCommand } from '@a-parallel/shared';

interface StartupCommandsPopoverProps {
  projectId: string;
}

export function StartupCommandsPopover({ projectId }: StartupCommandsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const loadCommands = useCallback(async () => {
    try {
      const cmds = await api.listCommands(projectId);
      setCommands(cmds);
    } catch {
      // ignore
    }
  }, [projectId]);

  useEffect(() => {
    if (open) loadCommands();
  }, [open, loadCommands]);

  const handleAdd = async () => {
    if (!label.trim() || !command.trim()) return;
    await api.addCommand(projectId, label.trim(), command.trim());
    setLabel('');
    setCommand('');
    setAdding(false);
    loadCommands();
  };

  const handleUpdate = async (cmdId: string) => {
    if (!label.trim() || !command.trim()) return;
    await api.updateCommand(projectId, cmdId, label.trim(), command.trim());
    setEditingId(null);
    setLabel('');
    setCommand('');
    loadCommands();
  };

  const handleDelete = async (cmdId: string) => {
    await api.deleteCommand(projectId, cmdId);
    loadCommands();
  };

  const handleRun = async (cmd: StartupCommand) => {
    // Create a terminal tab linked to this command
    const store = useTerminalStore.getState();
    const tabId = crypto.randomUUID();
    store.addTab({
      id: tabId,
      label: cmd.label,
      cwd: '',
      alive: true,
      commandId: cmd.id,
      projectId,
    });

    // Start the command on the server
    setRunningIds((prev) => new Set(prev).add(cmd.id));
    try {
      await api.runCommand(projectId, cmd.id);
    } catch {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(cmd.id);
        return next;
      });
    }

    setOpen(false);
  };

  const handleStop = async (cmd: StartupCommand) => {
    try {
      await api.stopCommand(projectId, cmd.id);
    } catch {
      // ignore
    }
    setRunningIds((prev) => {
      const next = new Set(prev);
      next.delete(cmd.id);
      return next;
    });
  };

  // Sync running state from terminal store
  const tabs = useTerminalStore((s) => s.tabs);
  useEffect(() => {
    const running = new Set<string>();
    for (const tab of tabs) {
      if (tab.commandId && tab.alive) running.add(tab.commandId);
    }
    setRunningIds(running);
  }, [tabs]);

  const startEditing = (cmd: StartupCommand) => {
    setEditingId(cmd.id);
    setLabel(cmd.label);
    setCommand(cmd.command);
    setAdding(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setAdding(false);
    setLabel('');
    setCommand('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Terminal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Startup commands</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-semibold">Startup Commands</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              cancelEdit();
              setAdding(!adding);
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Command list */}
        <div className="max-h-64 overflow-y-auto">
          {commands.length === 0 && !adding && (
            <p className="text-xs text-muted-foreground px-3 py-4 text-center">
              No commands configured yet
            </p>
          )}

          {commands.map((cmd) => {
            const isRunning = runningIds.has(cmd.id);
            return (
            <div key={cmd.id}>
              {editingId === cmd.id ? (
                /* Edit form */
                <div className="px-3 py-2 space-y-1.5 border-b border-border/50">
                  <input
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdate(cmd.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-xs" onClick={cancelEdit}>
                      <X className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => handleUpdate(cmd.id)}>
                      <Check className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                /* Command row */
                <div className="group flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors border-b border-border/50 last:border-b-0">
                  <button
                    onClick={() => !isRunning && handleRun(cmd)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-1.5">
                      {isRunning && (
                        <Loader2 className="h-3 w-3 animate-spin text-green-400 flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate">{cmd.label}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {cmd.command}
                    </div>
                  </button>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    {isRunning ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleStop(cmd)}
                            className="text-red-400 hover:text-red-300"
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Stop</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleRun(cmd)}
                            className="text-green-400 hover:text-green-300"
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Run</TooltipContent>
                      </Tooltip>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => startEditing(cmd)}
                      className="text-muted-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleDelete(cmd.id)}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
          })}
        </div>

        {/* Add form */}
        {adding && (
          <div className="px-3 py-2 space-y-1.5 border-t border-border">
            <input
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Label (e.g. Dev Server)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
            <input
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Command (e.g. npm run dev)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') cancelEdit();
              }}
            />
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button size="sm" className="h-6 text-xs" onClick={handleAdd}>
                Add
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

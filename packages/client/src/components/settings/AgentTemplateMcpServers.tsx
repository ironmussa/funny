import type {
  AgentTemplate,
  CreateAgentTemplateRequest,
  McpServer,
  McpServerType,
} from '@funny/shared';
import { Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ── MCP Servers Section ────────────────────────────────────

export function McpServersSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const servers: McpServer[] = template.mcpServers ?? [];
  const [adding, setAdding] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const removeServer = (idx: number) => {
    const next = servers.filter((_, i) => i !== idx);
    onSave({ mcpServers: next.length > 0 ? next : undefined });
    if (editingIdx === idx) setEditingIdx(null);
  };

  const saveServer = (server: McpServer, idx?: number) => {
    const next = [...servers];
    if (idx !== undefined && idx < next.length) {
      next[idx] = server;
    } else {
      next.push(server);
    }
    onSave({ mcpServers: next });
    setAdding(false);
    setEditingIdx(null);
  };

  return (
    <div>
      <p className="text-muted-foreground text-2xs mb-2">
        Configure MCP servers that will be attached to this agent at startup.
      </p>

      {servers.length > 0 && (
        <div className="mb-2 space-y-1">
          {servers.map((srv, idx) =>
            editingIdx === idx ? (
              <McpServerForm
                key={`${srv.name}-${srv.type}`}
                initial={srv}
                onSave={(s) => saveServer(s, idx)}
                onCancel={() => setEditingIdx(null)}
              />
            ) : (
              <div
                key={`${srv.name}-${srv.type}`}
                className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs"
                data-testid={`agent-template-mcp-server-${idx}`}
              >
                <Server className="text-muted-foreground size-3 shrink-0" />
                <span className="font-medium">{srv.name}</span>
                <span className="bg-muted text-muted-foreground text-2xs rounded px-1 py-0.5">
                  {srv.type}
                </span>
                <span className="text-muted-foreground truncate">
                  {srv.type === 'stdio' ? srv.command : srv.url}
                </span>
                <div className="ml-auto flex gap-1">
                  <button
                    aria-label={`Edit ${srv.name}`}
                    onClick={() => setEditingIdx(idx)}
                    className="text-muted-foreground hover:text-foreground rounded p-0.5"
                    data-testid={`agent-template-mcp-edit-${idx}`}
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    aria-label={`Delete ${srv.name}`}
                    onClick={() => removeServer(idx)}
                    className="text-muted-foreground hover:text-destructive rounded p-0.5"
                    data-testid={`agent-template-mcp-delete-${idx}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {adding ? (
        <McpServerForm onSave={(s) => saveServer(s)} onCancel={() => setAdding(false)} />
      ) : (
        <Button
          variant="outline"
          size="xs"
          onClick={() => setAdding(true)}
          data-testid="agent-template-mcp-add"
        >
          <Plus className="mr-1 size-3" />
          Add MCP Server
        </Button>
      )}
    </div>
  );
}

// ── MCP Server Form ────────────────────────────────────────

function McpServerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: McpServer;
  onSave: (server: McpServer) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<McpServerType>(initial?.type ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [argsStr, setArgsStr] = useState(() => (initial?.args ?? []).join(', '));
  const [envStr, setEnvStr] = useState(() =>
    Object.entries(initial?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

  const handleSave = () => {
    if (!name.trim()) return;
    const args = argsStr.split(',').flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [trimmed] : [];
    });
    const env: Record<string, string> = {};
    envStr.split('\n').forEach((line) => {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    });

    const server: McpServer = {
      name: name.trim(),
      type,
      command: type === 'stdio' ? command.trim() : undefined,
      args: type === 'stdio' && args.length > 0 ? args : undefined,
      url: type !== 'stdio' ? url.trim() : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
    onSave(server);
  };

  return (
    <div className="bg-muted/30 space-y-2 rounded border p-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="agent-template-mcp-name" className="text-muted-foreground text-2xs">
            Name
          </label>
          <Input
            size="xs"
            id="agent-template-mcp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="server-name"
            data-testid="agent-template-mcp-name"
          />
        </div>
        <div>
          <span id="agent-template-mcp-type-label" className="text-muted-foreground text-2xs">
            Type
          </span>
          <Select
            value={type}
            // SAFETY: the only items are stdio, http and sse, the McpServerType values.
            onValueChange={(v) => setType(v as McpServerType)}
          >
            <SelectTrigger
              aria-labelledby="agent-template-mcp-type-label"
              size="xs"
              data-testid="agent-template-mcp-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {type === 'stdio' ? (
        <>
          <div>
            <label htmlFor="agent-template-mcp-command" className="text-muted-foreground text-2xs">
              Command
            </label>
            <Input
              size="xs"
              id="agent-template-mcp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx -y @modelcontextprotocol/server-..."
              data-testid="agent-template-mcp-command"
            />
          </div>
          <div>
            <label htmlFor="agent-template-mcp-args" className="text-muted-foreground text-2xs">
              Args <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <Input
              size="xs"
              id="agent-template-mcp-args"
              value={argsStr}
              onChange={(e) => setArgsStr(e.target.value)}
              placeholder="--port, 3000"
              data-testid="agent-template-mcp-args"
            />
          </div>
        </>
      ) : (
        <div>
          <label htmlFor="agent-template-mcp-url" className="text-muted-foreground text-2xs">
            URL
          </label>
          <Input
            size="xs"
            id="agent-template-mcp-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            data-testid="agent-template-mcp-url"
          />
        </div>
      )}

      <div>
        <label htmlFor="agent-template-mcp-env" className="text-muted-foreground text-2xs">
          Environment Variables{' '}
          <span className="text-muted-foreground">(KEY=VALUE, one per line)</span>
        </label>
        <textarea
          id="agent-template-mcp-env"
          value={envStr}
          onChange={(e) => setEnvStr(e.target.value)}
          placeholder="API_KEY=sk-..."
          rows={2}
          className="bg-background w-full rounded-md border px-2 py-1 text-xs"
          data-testid="agent-template-mcp-env"
        />
      </div>

      <div className="flex gap-1">
        <Button
          variant="default"
          size="xs"
          onClick={handleSave}
          disabled={!name.trim()}
          data-testid="agent-template-mcp-save"
        >
          {initial ? 'Update' : 'Add'}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onCancel}
          data-testid="agent-template-mcp-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

import { Loader2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import type { McpAddForm } from './use-mcp-servers';

export function AddMcpServerForm({ form, onAdd }: { form: McpAddForm; onAdd: () => void }) {
  const { t } = useTranslation();
  const { addName, setAddName, addType, setAddType, addUrl, setAddUrl } = form;
  const { addCommand, setAddCommand, addArgs, setAddArgs, adding } = form;

  return (
    <div className="settings-form-panel mb-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="settings-label" htmlFor="mcp-custom-name">
            {t('mcp.name')}
          </label>
          <Input
            id="mcp-custom-name"
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="my-server"
            size="sm-tight"
          />
        </div>
        <div>
          <label className="settings-label" htmlFor="mcp-custom-type">
            {t('mcp.type')}
          </label>
          <Select
            value={addType}
            onValueChange={(v) => {
              if (v === 'stdio' || v === 'http' || v === 'sse') setAddType(v);
            }}
          >
            <SelectTrigger id="mcp-custom-type" className="h-8">
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

      {addType === 'http' || addType === 'sse' ? (
        <div>
          <label className="settings-label" htmlFor="mcp-custom-url">
            {t('mcp.url')}
          </label>
          <Input
            id="mcp-custom-url"
            type="text"
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
            size="sm-tight"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="settings-label" htmlFor="mcp-custom-command">
              {t('mcp.command')}
            </label>
            <Input
              id="mcp-custom-command"
              type="text"
              value={addCommand}
              onChange={(e) => setAddCommand(e.target.value)}
              placeholder="npx"
              size="sm-tight"
            />
          </div>
          <div>
            <label className="settings-label" htmlFor="mcp-custom-arguments">
              {t('mcp.arguments')}
            </label>
            <Input
              id="mcp-custom-arguments"
              type="text"
              value={addArgs}
              onChange={(e) => setAddArgs(e.target.value)}
              placeholder="-y @package/name"
              size="sm-tight"
            />
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={onAdd} disabled={!addName || adding}>
          {adding ? (
            <Loader2 className="icon-xs mr-1 animate-spin" />
          ) : (
            <Plus className="icon-xs mr-1" />
          )}
          {t('mcp.addServer')}
        </Button>
      </div>
    </div>
  );
}

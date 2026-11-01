/**
 * SandboxesSettings — the user's sandbox provider connections (change
 * thread-sandboxes). With a connection, a new thread can run in its own
 * sandbox: the compose box offers "Sandbox · <label>" as a runtime.
 *
 * The credential is sent once, validated by the server against the provider
 * and stored encrypted; it is never returned.
 */
import { Boxes, CheckCircle2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { InfraConnection, SandboxProviderInfo } from '@/lib/api/infra';
import { useSandboxConnectionsStore } from '@/stores/sandbox-connections-store';

function canSubmitConnection(form: {
  provider: string;
  label: string;
  credential: string;
  saving: boolean;
}): boolean {
  return !!form.provider && !!form.label.trim() && !!form.credential.trim() && !form.saving;
}

/** Form state + submit for a new provider connection. */
function useAddConnectionForm(providers: SandboxProviderInfo[], onAdded: () => void) {
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);

  // Providers load asynchronously: default to the first one once it arrives.
  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id);
  }, [provider, providers]);

  const handleAdd = async () => {
    setSaving(true);
    const result = await api.addInfraConnection({
      provider,
      label: label.trim(),
      credential: credential.trim(),
    });
    setSaving(false);
    if (result.isErr()) {
      toast.error(result.error.message || 'Could not add the connection');
      return;
    }
    toast.success(`Connected to ${result.value.label}`);
    setLabel('');
    setCredential('');
    onAdded();
  };

  return {
    provider,
    setProvider,
    label,
    setLabel,
    credential,
    setCredential,
    saving,
    canSubmit: canSubmitConnection({ provider, label, credential, saving }),
    handleAdd,
  };
}

function AddConnectionForm({
  providers,
  onAdded,
}: {
  providers: SandboxProviderInfo[];
  onAdded: () => void;
}) {
  const {
    provider,
    setProvider,
    label,
    setLabel,
    credential,
    setCredential,
    saving,
    canSubmit,
    handleAdd,
  } = useAddConnectionForm(providers, onAdded);

  return (
    <div className="settings-card space-y-3 p-4">
      <div>
        <p className="text-sm font-medium">Add a sandbox provider</p>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Each thread you start in a sandbox gets its own machine, created with this account. The
          key is checked with the provider and stored encrypted.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger size="xs" data-testid="sandbox-connection-provider">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name, e.g. Personal Boat"
          className="h-7 text-xs"
          data-testid="sandbox-connection-label"
        />
        <Input
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          placeholder="API key"
          className="h-7 font-mono text-xs"
          data-testid="sandbox-connection-credential"
        />
        <Button
          size="sm"
          className="h-6 self-start text-xs"
          disabled={!canSubmit}
          onClick={handleAdd}
          data-testid="sandbox-connection-add"
        >
          {saving ? 'Checking…' : 'Add connection'}
        </Button>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  providerName,
  onRemoved,
}: {
  connection: InfraConnection;
  providerName: string;
  onRemoved: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    const result = await api.testInfraConnection(connection.id);
    setTesting(false);
    if (result.isErr()) toast.error(result.error.message || 'The provider rejected the key');
    else toast.success(`${connection.label} works`);
  };

  const handleRemove = async () => {
    setRemoving(true);
    const result = await api.deleteInfraConnection(connection.id);
    setRemoving(false);
    setConfirmOpen(false);
    if (result.isErr()) {
      toast.error(result.error.message || 'Could not remove the connection');
      return;
    }
    onRemoved();
  };

  return (
    <div
      className="border-border/50 bg-card flex items-center gap-3 rounded-lg border px-3 py-2.5"
      data-testid={`sandbox-connection-${connection.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{connection.label}</span>
          <Badge variant="secondary">{providerName}</Badge>
        </div>
        {connection.accountLabel && (
          <p className="text-muted-foreground truncate text-xs">{connection.accountLabel}</p>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-xs"
        disabled={testing}
        onClick={handleTest}
        data-testid={`sandbox-connection-test-${connection.id}`}
      >
        <CheckCircle2 className="icon-xs mr-1" />
        {testing ? 'Testing…' : 'Test'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive h-6 text-xs"
        onClick={() => setConfirmOpen(true)}
        data-testid={`sandbox-connection-remove-${connection.id}`}
      >
        <Trash2 className="icon-xs" />
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove this connection?"
        description={`New threads will no longer be able to use "${connection.label}". Sandboxes that are already running keep working until they are stopped.`}
        confirmLabel="Remove"
        variant="destructive"
        loading={removing}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleRemove}
      />
    </div>
  );
}

export function SandboxesSettings() {
  const connections = useSandboxConnectionsStore((s) => s.connections);
  const loading = useSandboxConnectionsStore((s) => s.loading);
  const fetchConnections = useSandboxConnectionsStore((s) => s.fetch);
  const [providers, setProviders] = useState<SandboxProviderInfo[]>([]);

  useEffect(() => {
    void fetchConnections(true);
    void api.listSandboxProviders().then((result) => {
      if (result.isOk()) setProviders(result.value.providers);
    });
  }, [fetchConnections]);

  const refresh = () => void fetchConnections(true);
  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  return (
    <div className="space-y-6">
      <AddConnectionForm providers={providers} onAdded={refresh} />

      <div className="space-y-2">
        <p className="text-sm font-medium">My connections</p>
        {loading && connections.length === 0 ? (
          <LoadingState fill={false} label="Loading…" />
        ) : connections.length === 0 ? (
          <EmptyState
            fill={false}
            className="border-border/50 rounded-lg border border-dashed px-4 py-6"
            icon={Boxes}
            title="No sandbox providers connected yet."
            description="Add one above to run threads in their own sandbox."
          />
        ) : (
          <div className="space-y-2">
            {connections.map((c) => (
              <ConnectionRow
                key={c.id}
                connection={c}
                providerName={providerName(c.provider)}
                onRemoved={refresh}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

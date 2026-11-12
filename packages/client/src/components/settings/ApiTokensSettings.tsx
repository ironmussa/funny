import type { TFunction } from 'i18next';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
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
import type { PersonalAccessTokenInfo } from '@/lib/api/personal-tokens';
import { cn } from '@/lib/utils';

const EXPIRY_DAYS = ['30', '90', '365'] as const;
type ExpiryDays = (typeof EXPIRY_DAYS)[number];

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

type TokenState = 'active' | 'revoked' | 'expired';

function tokenState(token: PersonalAccessTokenInfo, now: number): TokenState {
  if (token.revokedAt) return 'revoked';
  return Date.parse(token.expiresAt) <= now ? 'expired' : 'active';
}

interface Listing {
  tokens: PersonalAccessTokenInfo[];
  /** When the list was read: what "expired" is judged against. */
  loadedAt: number;
}

async function fetchListing(t: TFunction): Promise<Listing> {
  const result = await api.listPersonalTokens();
  if (result.isErr()) toast.error(t('apiTokens.loadFailed'));
  return { tokens: result.isOk() ? result.value : [], loadedAt: Date.now() };
}

/**
 * The user's personal API tokens for the public REST API `/api/v1`
 * (public-rest-api-v1): list, create (the plaintext is shown once) and revoke.
 */
export function ApiTokensSettings() {
  const { t } = useTranslation();
  const [listing, setListing] = useState<Listing | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<ExpiryDays>('90');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PersonalAccessTokenInfo | null>(null);

  const load = useCallback(() => fetchListing(t).then(setListing), [t]);

  useEffect(() => {
    void fetchListing(t).then(setListing);
  }, [t]);

  const create = async () => {
    setBusy(true);
    const result = await api.createPersonalToken({ name: name.trim(), days: Number(days) });
    setBusy(false);
    if (result.isErr()) {
      toast.error(t('apiTokens.createFailed'));
      return;
    }
    setCreated(result.value.token);
    setName('');
    const info = result.value.info;
    setListing((prev) => ({
      tokens: [info, ...(prev?.tokens ?? [])],
      loadedAt: prev?.loadedAt ?? Date.parse(info.createdAt),
    }));
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    const result = await api.revokePersonalToken(revoking.id);
    setBusy(false);
    setRevoking(null);
    if (result.isErr()) {
      toast.error(t('apiTokens.revokeFailed'));
      return;
    }
    toast.success(t('apiTokens.revoked'));
    void load();
  };

  if (!listing) return <LoadingState />;
  const { tokens, loadedAt } = listing;

  return (
    <div className="space-y-4" data-testid="settings-api-tokens">
      <div>
        <h3 className="text-sm font-semibold">{t('apiTokens.title')}</h3>
        <p className="text-muted-foreground text-xs">{t('apiTokens.description')}</p>
      </div>

      <div className="border-border/50 space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-64"
            placeholder={t('apiTokens.namePlaceholder')}
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            data-testid="settings-api-tokens-name"
          />
          <Select value={days} onValueChange={(v) => setDays(v as ExpiryDays)}>
            <SelectTrigger className="w-40" data-testid="settings-api-tokens-expiry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((d) => (
                <SelectItem key={d} value={d} data-testid={`settings-api-tokens-expiry-${d}`}>
                  {t('apiTokens.expiresInDays', { count: Number(d) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={create}
            disabled={busy || !name.trim()}
            data-testid="settings-api-tokens-create"
          >
            {t('apiTokens.create')}
          </Button>
        </div>

        {created && (
          <Alert data-testid="settings-api-tokens-created">
            <AlertTriangle className="icon-base" />
            <AlertDescription className="space-y-2 text-xs">
              <p>{t('apiTokens.shownOnce')}</p>
              <div className="flex items-center gap-2">
                <code
                  className="bg-muted min-w-0 flex-1 rounded px-2 py-1 font-mono break-all"
                  data-testid="settings-api-tokens-created-value"
                >
                  {created}
                </code>
                <CopyButton
                  value={created}
                  label={t('apiTokens.copy')}
                  data-testid="settings-api-tokens-copy"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreated(null)}
                data-testid="settings-api-tokens-dismiss"
              >
                {t('apiTokens.dismiss')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {tokens.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="settings-api-tokens-empty">
          {t('apiTokens.empty')}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="settings-api-tokens-list">
          {tokens.map((token) => {
            const state = tokenState(token, loadedAt);
            return (
              <li
                key={token.id}
                className={cn(
                  'border-border/50 flex items-center gap-3 rounded-lg border p-3',
                  state !== 'active' && 'opacity-60',
                )}
                data-testid={`settings-api-tokens-item-${token.id}`}
              >
                <KeyRound className="icon-base text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{token.name}</span>
                    <code className="text-muted-foreground font-mono text-xs">{token.prefix}…</code>
                    {state !== 'active' && (
                      <Badge
                        variant={state === 'revoked' ? 'destructive' : 'secondary'}
                        data-testid={`settings-api-tokens-state-${token.id}`}
                      >
                        {t(`apiTokens.state.${state}`)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t('apiTokens.dates', {
                      created: formatDate(token.createdAt),
                      expires: formatDate(token.expiresAt),
                    })}
                    {' · '}
                    {token.lastUsedAt
                      ? t('apiTokens.lastUsed', { date: formatDate(token.lastUsedAt) })
                      : t('apiTokens.neverUsed')}
                  </p>
                </div>
                {!token.revokedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRevoking(token)}
                    disabled={busy}
                    data-testid={`settings-api-tokens-revoke-${token.id}`}
                  >
                    {t('apiTokens.revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('apiTokens.revokeTitle')}
        description={t('apiTokens.revokeDescription', { name: revoking?.name ?? '' })}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('apiTokens.revoke')}
        loading={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      />
    </div>
  );
}

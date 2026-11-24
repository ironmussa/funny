import type { McpServer, McpServerType } from '@funny/shared';
import {
  Trash2,
  Globe,
  Terminal,
  Loader2,
  Download,
  ShieldAlert,
  KeyRound,
  Check,
  XCircle,
  FileJson,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { openClaudeSettingsInEditor } from '@/lib/claude-settings';
import { cn } from '@/lib/utils';

export interface RecommendedServer {
  name: string;
  description: string;
  type: McpServerType;
  url?: string;
  command?: string;
  args?: string[];
}

function isClaudeAiConnectorName(name: string): boolean {
  return name.startsWith('claude.ai') || name.startsWith('claude_ai_');
}

function ClaudeSettingsEditorButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn('h-6', className)}
      data-testid="mcp-edit-claude-settings"
      onClick={() => void openClaudeSettingsInEditor()}
    >
      <FileJson className="icon-xs mr-1" />
      {t('mcp.editClaudeSettings')}
    </Button>
  );
}

function McpServerToggle({
  server,
  toggling,
  isDisabled,
  onToggle,
}: {
  server: McpServer;
  toggling: boolean;
  isDisabled: boolean;
  onToggle: (disabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const notToggleable = server.toggleable === false;
  const isClaudeAi = isClaudeAiConnectorName(server.name);
  const tooltipKey =
    server.provider === 'codex'
      ? 'mcp.externalToggleTooltipCodex'
      : isClaudeAi
        ? 'mcp.externalToggleTooltipClaudeAi'
        : 'mcp.externalToggleTooltipPlugin';

  const switchControl = (
    <Switch
      data-testid={`mcp-toggle-${server.name}`}
      checked={!isDisabled}
      onCheckedChange={(checked) => onToggle(!checked)}
      disabled={toggling || notToggleable}
    />
  );

  if (!notToggleable) return switchControl;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex cursor-not-allowed"
          data-testid={`mcp-toggle-disabled-wrap-${server.name}`}
        >
          {switchControl}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs p-3 text-left">
        <p className="leading-snug">{t(tooltipKey)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const PROTOCOL_BADGE_VARIANT = {
  http: 'info',
  sse: 'warning',
  stdio: 'success',
} as const satisfies Record<McpServerType, 'info' | 'warning' | 'success'>;

function McpProtocolBadge({ type }: { type: McpServerType }) {
  return (
    <Badge
      variant={PROTOCOL_BADGE_VARIANT[type]}
      size="xs"
      data-testid={`mcp-protocol-badge-${type}`}
      className="rounded-md tracking-wider uppercase"
    >
      {type === 'stdio' ? <Terminal className="icon-2xs" /> : <Globe className="icon-2xs" />}
      {type}
    </Badge>
  );
}

function McpStatusBadge({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Badge
      variant="outline"
      size="xs"
      data-testid={testId}
      className={cn('rounded-md border-transparent font-medium', className)}
    >
      {children}
    </Badge>
  );
}

export function InstalledServerCard({
  server,
  onRemove,
  removing,
  onToggle,
  toggling,
  onAuthenticate,
  authenticating,
  onSetToken,
  settingToken,
}: {
  server: McpServer;
  onRemove: () => void;
  removing: boolean;
  onToggle: (disabled: boolean) => void;
  toggling: boolean;
  onAuthenticate?: () => void;
  authenticating?: boolean;
  onSetToken?: (token: string) => void;
  settingToken?: boolean;
}) {
  const { t } = useTranslation();
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenValue, setTokenValue] = useState('');
  const isDisabled = server.disabled === true;
  const showClaudeSettingsEditor =
    server.toggleable === false && isClaudeAiConnectorName(server.name);
  const needsAuthActions = !isDisabled && server.status === 'needs_auth';

  return (
    <Card
      data-testid={`mcp-installed-card-${server.name}`}
      className={cn(
        'flex flex-col shadow-none',
        isDisabled
          ? 'border-border/30 opacity-60'
          : server.status === 'needs_auth'
            ? 'border-status-warning/50'
            : server.status === 'error'
              ? 'border-status-error/50'
              : undefined,
      )}
    >
      <CardHeader className="flex flex-row items-start gap-3 space-y-0 p-4 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle
              className={cn(
                'truncate text-sm font-medium leading-snug',
                isDisabled && 'text-muted-foreground',
              )}
            >
              {server.name}
            </CardTitle>
            <McpProtocolBadge type={server.type} />
            {!isDisabled && server.status === 'error' && (
              <McpStatusBadge
                testId={`mcp-status-error-${server.name}`}
                className="bg-status-error/15 text-status-error"
              >
                <XCircle className="icon-2xs" />
                {t('mcp.failed')}
              </McpStatusBadge>
            )}
            {isDisabled && (
              <McpStatusBadge
                testId={`mcp-status-disabled-${server.name}`}
                className="bg-muted text-muted-foreground"
              >
                {t('mcp.disabled')}
              </McpStatusBadge>
            )}
            {server.toggleable === false && (
              <McpStatusBadge
                testId={`mcp-status-managed-${server.name}`}
                className="bg-muted text-muted-foreground"
              >
                {t('mcp.managedExternally')}
              </McpStatusBadge>
            )}
          </div>
          <CardDescription className="mt-1 truncate text-xs">
            {server.url || [server.command, ...(server.args || [])].join(' ')}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showClaudeSettingsEditor && !needsAuthActions && <ClaudeSettingsEditorButton />}
          <McpServerToggle
            server={server}
            toggling={toggling}
            isDisabled={isDisabled}
            onToggle={onToggle}
          />
          <TooltipIconButton
            variant="muted-destructive"
            onClick={onRemove}
            disabled={removing}

            tooltip={t('common.delete')}
          >
            {removing ? (
              <Loader2 className="icon-sm animate-spin" />
            ) : (
              <Trash2 className="icon-sm" />
            )}
          </TooltipIconButton>
        </div>
      </CardHeader>
      {needsAuthActions && (
        <CardFooter className="flex-col items-stretch gap-2 p-4 pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              onClick={onAuthenticate}
              disabled={authenticating || settingToken}
              className="border-status-warning/30 text-status-warning hover:bg-status-warning/10 h-6"
              data-testid={`mcp-oauth-${server.name}`}
            >
              {authenticating ? (
                <Loader2 className="icon-xs mr-1 animate-spin" />
              ) : (
                <ShieldAlert className="icon-xs mr-1" />
              )}
              {authenticating ? t('mcp.authenticating') : 'OAuth'}
            </Button>
            <Button
              variant={showTokenInput ? 'secondary' : 'outline'}
              size="xs"
              onClick={() => setShowTokenInput(!showTokenInput)}
              disabled={authenticating || settingToken}
              className="h-6"
              data-testid={`mcp-manual-token-${server.name}`}
            >
              <KeyRound className="icon-xs mr-1" />
              {t('mcp.manualToken')}
            </Button>
            {showClaudeSettingsEditor && <ClaudeSettingsEditorButton />}
          </div>
          {showTokenInput && (
            <div className="flex items-center gap-2">
              <Input
                size="xs"
                type="password"
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder={t('mcp.tokenPlaceholder')}
                className="flex-1"
                data-testid={`mcp-token-input-${server.name}`}
              />
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  if (tokenValue && onSetToken) {
                    onSetToken(tokenValue);
                    setTokenValue('');
                    setShowTokenInput(false);
                  }
                }}
                disabled={!tokenValue || settingToken}
                data-testid={`mcp-token-save-${server.name}`}
              >
                {settingToken ? (
                  <Loader2 className="icon-xs animate-spin" />
                ) : (
                  <Check className="icon-xs" />
                )}
              </Button>
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

export function RecommendedServerCard({
  server,
  installed,
  onInstall,
  installing,
}: {
  server: RecommendedServer;
  installed: boolean;
  onInstall: () => void;
  installing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Card
      data-testid={`mcp-recommended-card-${server.name}`}
      className="flex h-full flex-col shadow-none"
    >
      <CardHeader className="flex-1 space-y-2 p-4 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm leading-snug font-medium">{server.name}</CardTitle>
          <McpProtocolBadge type={server.type} />
        </div>
        <CardDescription className="line-clamp-3 text-xs leading-relaxed">
          {server.description}
        </CardDescription>
      </CardHeader>
      <CardFooter className="p-4 pt-0">
        <Button
          variant={installed ? 'ghost' : 'outline'}
          size="sm"
          onClick={onInstall}
          disabled={installed || installing}
          className="w-full"
          data-testid={`mcp-install-${server.name}`}
        >
          {installing ? (
            <Loader2 className="icon-xs mr-1 animate-spin" />
          ) : installed ? null : (
            <Download className="icon-xs mr-1" />
          )}
          {installed ? t('mcp.installed') : installing ? t('mcp.installing') : t('mcp.install')}
        </Button>
      </CardFooter>
    </Card>
  );
}

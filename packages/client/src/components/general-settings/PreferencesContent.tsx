import { PROVIDER_KEY_REGISTRY } from '@funny/shared/models';
import { Mail, Send } from 'lucide-react';
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ADMIN_ONLY_PREFERENCES, type GeneralPage } from '@/components/PreferencesPanel';
import { AgentExecutionProfilesSettings } from '@/components/settings/AgentExecutionProfilesSettings';
import { AgentTemplateSettings } from '@/components/settings/AgentTemplateSettings';
import { ExtensionsSettings } from '@/components/settings/ExtensionsSettings';
import { GithubAppSettings } from '@/components/settings/GithubAppSettings';
import { OrganizationManagement } from '@/components/settings/OrganizationManagement';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { RunnersSettings } from '@/components/settings/RunnersSettings';
import { SandboxesSettings } from '@/components/settings/SandboxesSettings';
import { SystemSettings } from '@/components/settings/SystemSettings';
import { TeamMembers } from '@/components/settings/TeamMembers';
import { UserManagement } from '@/components/settings/UserManagement';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

import {
  AppearancePreferencesSection,
  ModelsPreferencesSection,
} from './AppearancePreferencesSection';
import { GeneralPreferencesSection } from './GeneralPreferencesSection';
import {
  type ProviderKeysState,
  type SmtpSource,
  useProviderKeys,
  useSmtpSettings,
} from './preferences-hooks';

interface Props {
  activePreferencesPage: GeneralPage;
}

/** Pages that own all of their state. */
const STANDALONE_PAGES: Partial<Record<GeneralPage, ComponentType>> = {
  general: GeneralPreferencesSection,
  models: ModelsPreferencesSection,
  appearance: AppearancePreferencesSection,
  users: UserManagement,
  organizations: OrganizationManagement,
  'team-members': TeamMembers,
  runners: RunnersSettings,
  sandboxes: SandboxesSettings,
  'agent-profiles': AgentExecutionProfilesSettings,
  'agent-templates': AgentTemplateSettings,
  extensions: ExtensionsSettings,
  'github-app': GithubAppSettings,
  providers: ProvidersSettings,
  system: SystemSettings,
};

interface SharedPageState {
  keys: ProviderKeysState;
  smtp: ReturnType<typeof useSmtpSettings>;
}

/** Pages whose state is owned by PreferencesContent so it survives page switches. */
const STATEFUL_PAGES: Partial<Record<GeneralPage, (state: SharedPageState) => ReactNode>> = {
  github: ({ keys }) => <GitHubTokenSection keys={keys} />,
  'ai-keys': ({ keys }) => <AiProviderKeysSection keys={keys} />,
  speech: ({ keys }) => <SpeechKeySection keys={keys} />,
  email: ({ smtp }) => <SmtpPanel {...smtp} />,
};

function PreferencesPage({ page, state }: { page: GeneralPage; state: SharedPageState }) {
  const Standalone = STANDALONE_PAGES[page];
  if (Standalone) return <Standalone />;
  return STATEFUL_PAGES[page]?.(state) ?? null;
}

function AdminOnlyNotice() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="max-w-4xl px-8 py-8">
        <p className="text-muted-foreground text-sm" data-testid="preferences-admin-only">
          This setting is only available to administrators.
        </p>
      </div>
    </ScrollArea>
  );
}

/**
 * The right-side scrollable content area of the preferences view. Owns the
 * pages' shared local state (provider keys, SMTP settings); each page section
 * owns its own auto-save handlers. Extracted so GeneralSettingsView is a thin
 * layout shell.
 */
export function PreferencesContent({ activePreferencesPage }: Props) {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const fetchAvailableShells = useSettingsStore((s) => s.fetchAvailableShells);
  // Hook order matters: their mount effects load the profile, then SMTP, then shells.
  const keys = useProviderKeys();
  const smtp = useSmtpSettings();

  useEffect(() => {
    fetchAvailableShells();
  }, [fetchAvailableShells]);

  // Defense in depth: the nav hides admin-only pages for non-admins, but a
  // direct URL (e.g. /preferences/system) must not render one either.
  if (!isAdmin && ADMIN_ONLY_PREFERENCES.has(activePreferencesPage)) {
    return <AdminOnlyNotice />;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="max-w-4xl px-8 py-8">
        <PreferencesPage page={activePreferencesPage} state={{ keys, smtp }} />
      </div>
    </ScrollArea>
  );
}

// ── Provider key pages ───────────────────────────────────────────────

function GitHubTokenSection({ keys }: { keys: ProviderKeysState }) {
  const { t } = useTranslation();
  return (
    <ProviderKeyPanel
      id="github"
      label="GitHub token"
      title={t('profile.githubTokenLabel')}
      description={t('profile.githubTokenDesc')}
      keyInputs={keys.keyInputs}
      keyPresence={keys.keyPresence}
      keySaving={keys.keySaving}
      setKeyInputs={keys.setKeyInputs}
      handleSave={keys.handleSave}
      handleClear={keys.handleClear}
      saveTestId="preferences-save-token"
      inputTestId="preferences-github-token"
      clearTestId="preferences-clear-token"
      t={t}
    />
  );
}

function ProviderKeyRowFor({
  keys,
  id,
  label,
}: {
  keys: ProviderKeysState;
  id: string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <ProviderKeyRow
      id={id}
      label={label}
      keyInputs={keys.keyInputs}
      keyPresence={keys.keyPresence}
      keySaving={keys.keySaving}
      setKeyInputs={keys.setKeyInputs}
      handleSave={keys.handleSave}
      handleClear={keys.handleClear}
      t={t}
    />
  );
}

/** GitHub and AssemblyAI have their own pages. */
const AI_PROVIDER_KEYS = PROVIDER_KEY_REGISTRY.filter(
  (k) => k.id !== 'github' && k.id !== 'assemblyai',
);

function AiProviderKeysSection({ keys }: { keys: ProviderKeysState }) {
  return (
    <>
      <p className="text-muted-foreground px-1 pb-3 text-sm">
        Configure API keys for AI providers. Keys are encrypted at rest.
      </p>
      <div className="settings-card divide-border space-y-0 divide-y">
        {AI_PROVIDER_KEYS.map((keyConfig) => (
          <div key={keyConfig.id} className="px-4 py-3.5">
            <p className="settings-row-title">{keyConfig.label}</p>
            <p className="settings-row-desc mb-2">
              Get your key at{' '}
              <a
                href={keyConfig.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {new URL(keyConfig.helpUrl).hostname}
              </a>
              . {keyConfig.description}
            </p>
            <ProviderKeyRowFor keys={keys} id={keyConfig.id} label={keyConfig.label} />
          </div>
        ))}
      </div>
    </>
  );
}

function SpeechKeySection({ keys }: { keys: ProviderKeysState }) {
  return (
    <>
      <p className="text-muted-foreground px-1 pb-3 text-sm">
        Configure an AssemblyAI API key to enable voice dictation in the prompt input.
      </p>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="settings-row-title">AssemblyAI API Key</p>
          <p className="settings-row-desc mb-2">
            Get your key at{' '}
            <a
              href="https://www.assemblyai.com/dashboard/signup"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              assemblyai.com
            </a>
            . The key is encrypted at rest.
          </p>
          <ProviderKeyRowFor keys={keys} id="assemblyai" label="AssemblyAI API Key" />
        </div>
      </div>
    </>
  );
}

interface KeyRowProps {
  id: string;
  label: string;
  keyInputs: Record<string, string>;
  keyPresence: Record<string, boolean>;
  keySaving: Record<string, boolean>;
  setKeyInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  handleSave: (id: string) => void;
  handleClear: (id: string) => void;
  t: (key: string) => string;
}

function ProviderKeyRow({
  id,
  label,
  keyInputs,
  keyPresence,
  keySaving,
  setKeyInputs,
  handleSave,
  handleClear,
  t,
}: KeyRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        value={keyInputs[id] ?? ''}
        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
        data-testid={`preferences-${id}-key`}
        placeholder={keyPresence[id] ? t('profile.tokenSaved') : `Enter your ${label}`}
        className="text-sm"
      />
      <Button
        size="sm"
        onClick={() => handleSave(id)}
        disabled={!keyInputs[id] || !!keySaving[id]}
        data-testid={`preferences-save-${id}-key`}
      >
        {keySaving[id] ? t('common.saving') : t('common.save')}
      </Button>
      {keyPresence[id] && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive shrink-0 text-xs"
          onClick={() => handleClear(id)}
          disabled={!!keySaving[id]}
          data-testid={`preferences-clear-${id}-key`}
        >
          {t('profile.clearToken')}
        </Button>
      )}
    </div>
  );
}

function ProviderKeyPanel({
  id,
  title,
  description,
  keyInputs,
  keyPresence,
  keySaving,
  setKeyInputs,
  handleSave,
  handleClear,
  saveTestId,
  inputTestId,
  clearTestId,
  t,
}: KeyRowProps & {
  title: string;
  description: string;
  saveTestId: string;
  inputTestId: string;
  clearTestId: string;
}) {
  return (
    <>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="settings-row-title">{title}</p>
          <p className="settings-row-desc mb-2">{description}</p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={keyInputs[id] ?? ''}
              onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
              data-testid={inputTestId}
              placeholder={
                keyPresence[id] ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
              }
              className="text-sm"
            />
            <Button
              size="sm"
              onClick={() => handleSave(id)}
              disabled={!keyInputs[id] || !!keySaving[id]}
              data-testid={saveTestId}
            >
              {keySaving[id] ? t('common.saving') : t('common.save')}
            </Button>
            {keyPresence[id] && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive shrink-0 text-xs"
                onClick={() => handleClear(id)}
                disabled={!!keySaving[id]}
                data-testid={clearTestId}
              >
                {t('profile.clearToken')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface SmtpPanelProps {
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpHasPassword: boolean;
  smtpSource: SmtpSource;
  smtpSaving: boolean;
  smtpTesting: boolean;
  setSmtpHost: (v: string) => void;
  setSmtpPort: (v: string) => void;
  setSmtpUser: (v: string) => void;
  setSmtpPass: (v: string) => void;
  setSmtpFrom: (v: string) => void;
  handleSaveSmtp: () => void;
  handleTestSmtp: () => void;
}

function SmtpStatusBadge({ source }: { source: SmtpSource }) {
  if (source === 'none') return null;
  const fromDatabase = source === 'database';
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium',
        fromDatabase ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}
      data-testid="preferences-smtp-status"
    >
      {fromDatabase ? 'Configured' : 'Env vars'}
    </span>
  );
}

function SmtpField({
  id,
  label,
  value,
  onChange,
  placeholder,
  testId,
  type,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-muted-foreground mb-1 block text-xs">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="text-sm"
        data-testid={testId}
      />
    </div>
  );
}

function SmtpActions({
  canSave,
  canTest,
  smtpSaving,
  smtpTesting,
  handleSaveSmtp,
  handleTestSmtp,
}: {
  canSave: boolean;
  canTest: boolean;
  smtpSaving: boolean;
  smtpTesting: boolean;
  handleSaveSmtp: () => void;
  handleTestSmtp: () => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button
        size="sm"
        onClick={handleSaveSmtp}
        disabled={!canSave}
        data-testid="preferences-smtp-save"
      >
        <Mail className="icon-sm mr-1.5" />
        {smtpSaving ? 'Saving...' : 'Save SMTP'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={handleTestSmtp}
        disabled={!canTest}
        data-testid="preferences-smtp-test"
      >
        <Send className="icon-sm mr-1.5" />
        {smtpTesting ? 'Sending...' : 'Send Test Email'}
      </Button>
    </div>
  );
}

function SmtpPanel(props: SmtpPanelProps) {
  const { smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpHasPassword, smtpSource } = props;
  const { smtpSaving, smtpTesting, setSmtpHost, setSmtpPort, setSmtpUser, setSmtpPass } = props;
  const canSave = !!smtpHost && !!smtpUser && !smtpSaving;
  const canTest = smtpSource !== 'none' && !smtpTesting;
  const passwordPlaceholder = smtpHasPassword
    ? 'Password saved (enter new to replace)'
    : 'App password or SMTP password';

  return (
    <>
      <div className="flex items-center gap-2">
        <SmtpStatusBadge source={smtpSource} />
      </div>
      <p className="text-muted-foreground px-1 pb-3 text-sm">
        Used for sending team invitation emails. Set via env vars (SMTP_HOST, SMTP_USER, SMTP_PASS)
        or configure below.
      </p>
      <div className="settings-card">
        <div className="space-y-3 px-4 py-3.5">
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <SmtpField
              id="preferences-smtp-host"
              label="Host"
              value={smtpHost}
              onChange={setSmtpHost}
              placeholder="smtp.gmail.com"
              testId="preferences-smtp-host"
            />
            <SmtpField
              id="preferences-smtp-port"
              label="Port"
              value={smtpPort}
              onChange={setSmtpPort}
              placeholder="587"
              testId="preferences-smtp-port"
            />
          </div>
          <SmtpField
            id="preferences-smtp-user"
            label="Username"
            value={smtpUser}
            onChange={setSmtpUser}
            placeholder="you@example.com"
            testId="preferences-smtp-user"
          />
          <SmtpField
            id="preferences-smtp-password"
            type="password"
            label="Password"
            value={smtpPass}
            onChange={setSmtpPass}
            placeholder={passwordPlaceholder}
            testId="preferences-smtp-pass"
          />
          <SmtpField
            id="preferences-smtp-from"
            label="From address"
            value={smtpFrom}
            onChange={props.setSmtpFrom}
            placeholder="noreply@example.com"
            testId="preferences-smtp-from"
          />
          <SmtpActions
            canSave={canSave}
            canTest={canTest}
            smtpSaving={smtpSaving}
            smtpTesting={smtpTesting}
            handleSaveSmtp={props.handleSaveSmtp}
            handleTestSmtp={props.handleTestSmtp}
          />
        </div>
      </div>
    </>
  );
}

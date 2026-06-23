import type { AgentExecutionProfileResponse } from '@funny/shared';
import { Bot, Check, Copy, Plus, Save, Trash2 } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

const NO_PROFILE_VALUE = '__default__';
const CONFIG_DIR_PLACEHOLDER = '<config-dir>';
const SHELL_SAFE_VALUE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

interface ProfileDraft {
  name: string;
  configDir: string;
}

function profileToDraft(profile: AgentExecutionProfileResponse): ProfileDraft {
  return {
    name: profile.name,
    configDir: profile.config.claude.configDir,
  };
}

function profilesToDrafts(profiles: AgentExecutionProfileResponse[]): Record<string, ProfileDraft> {
  return Object.fromEntries(profiles.map((profile) => [profile.id, profileToDraft(profile)]));
}

function profileDraftPayload(draft: ProfileDraft) {
  return {
    name: draft.name.trim(),
    config: { claude: { configDir: draft.configDir.trim() } },
  };
}

function shellQuoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return CONFIG_DIR_PLACEHOLDER;
  if (SHELL_SAFE_VALUE.test(trimmed)) return trimmed;
  return `'${trimmed.replaceAll("'", "'\\''")}'`;
}

function buildClaudeAuthCommand(configDir: string) {
  return `CLAUDE_CONFIG_DIR=${shellQuoteEnvValue(configDir)} claude auth login`;
}

export function AgentExecutionProfilesSettings() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<AgentExecutionProfileResponse[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [createDraft, setCreateDraft] = useState<ProfileDraft>({
    name: '',
    configDir: '',
  });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const profilesResult = await api.listAgentExecutionProfiles();
    if (profilesResult.isErr()) {
      toast.error(t('agentProfiles.loadError', 'Failed to load agent profiles'), {
        description: profilesResult.error.message,
      });
      setLoading(false);
      return;
    }

    setProfiles(profilesResult.value.profiles);
    setDrafts(profilesToDrafts(profilesResult.value.profiles));
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDraft = useCallback((id: string, field: keyof ProfileDraft, value: string) => {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { name: '', configDir: '' }),
        [field]: value,
      },
    }));
  }, []);

  const createProfile = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const payload = profileDraftPayload(createDraft);
      if (!payload.name || !payload.config.claude.configDir) {
        toast.error(t('agentProfiles.required', 'Name and config directory are required'));
        return;
      }

      setCreating(true);
      const result = await api.createAgentExecutionProfile({
        provider: 'claude',
        ...payload,
      });
      setCreating(false);

      if (result.isErr()) {
        toast.error(t('agentProfiles.createError', 'Failed to create profile'), {
          description: result.error.message,
        });
        return;
      }

      setProfiles((current) => [...current, result.value]);
      setDrafts((current) => ({ ...current, [result.value.id]: profileToDraft(result.value) }));
      setCreateDraft({ name: '', configDir: '' });
      toast.success(t('agentProfiles.created', 'Profile created'));
    },
    [createDraft, t],
  );

  const saveProfile = useCallback(
    async (profile: AgentExecutionProfileResponse) => {
      const draft = drafts[profile.id];
      if (!draft) return;
      const payload = profileDraftPayload(draft);
      if (!payload.name || !payload.config.claude.configDir) {
        toast.error(t('agentProfiles.required', 'Name and config directory are required'));
        return;
      }

      setSavingId(profile.id);
      const result = await api.updateAgentExecutionProfile(profile.id, payload);
      setSavingId(null);

      if (result.isErr()) {
        toast.error(t('agentProfiles.saveError', 'Failed to save profile'), {
          description: result.error.message,
        });
        return;
      }

      setProfiles((current) =>
        current.map((item) => (item.id === result.value.id ? result.value : item)),
      );
      setDrafts((current) => ({ ...current, [result.value.id]: profileToDraft(result.value) }));
      toast.success(t('agentProfiles.saved', 'Profile saved'));
    },
    [drafts, t],
  );

  const deleteProfile = useCallback(
    async (profile: AgentExecutionProfileResponse) => {
      setSavingId(profile.id);
      const result = await api.deleteAgentExecutionProfile(profile.id);
      setSavingId(null);

      if (result.isErr()) {
        toast.error(t('agentProfiles.deleteError', 'Failed to delete profile'), {
          description: result.error.message,
        });
        return;
      }

      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      toast.success(t('agentProfiles.deleted', 'Profile deleted'));
    },
    [t],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t('agentProfiles.profiles', 'Profiles')}</h3>
            <p className="text-muted-foreground text-xs">Claude</p>
          </div>
        </div>

        <CreateProfileForm
          draft={createDraft}
          creating={creating}
          onDraftChange={setCreateDraft}
          onSubmit={createProfile}
        />

        {profiles.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
            <Bot className="mx-auto mb-2 size-8 opacity-50" />
            {t('agentProfiles.empty', 'No profiles yet.')}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <ProfileEditor
                key={profile.id}
                profile={profile}
                draft={drafts[profile.id] ?? profileToDraft(profile)}
                saving={savingId === profile.id}
                onDraftChange={updateDraft}
                onSave={saveProfile}
                onDelete={deleteProfile}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectAgentExecutionProfileSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProject = useProjectStore((s) =>
    s.projects.find((project) => project.id === s.selectedProjectId),
  );
  const [profiles, setProfiles] = useState<AgentExecutionProfileResponse[]>([]);
  const [bindingProfileId, setBindingProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bindingSaving, setBindingSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const profilesResult = await api.listAgentExecutionProfiles();
    if (profilesResult.isErr()) {
      toast.error(t('agentProfiles.loadError', 'Failed to load agent profiles'), {
        description: profilesResult.error.message,
      });
      setLoading(false);
      return;
    }

    setProfiles(profilesResult.value.profiles);

    if (selectedProjectId) {
      const bindingResult = await api.getProjectAgentProfileBinding(selectedProjectId);
      if (bindingResult.isOk()) {
        setBindingProfileId(bindingResult.value.profile?.id ?? null);
      } else {
        toast.error(t('agentProfiles.bindingLoadError', 'Failed to load project profile'), {
          description: bindingResult.error.message,
        });
        setBindingProfileId(null);
      }
    } else {
      setBindingProfileId(null);
    }

    setLoading(false);
  }, [selectedProjectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateBinding = useCallback(
    async (value: string) => {
      if (!selectedProjectId) return;
      const nextProfileId = value === NO_PROFILE_VALUE ? null : value;
      setBindingProfileId(nextProfileId);
      setBindingSaving(true);

      const result = await api.updateProjectAgentProfileBinding(selectedProjectId, {
        profileId: nextProfileId,
      });
      setBindingSaving(false);

      if (result.isErr()) {
        toast.error(t('agentProfiles.bindingSaveError', 'Failed to save project profile'), {
          description: result.error.message,
        });
        await load();
        return;
      }

      setBindingProfileId(result.value.profile?.id ?? null);
      toast.success(t('agentProfiles.bindingSaved', 'Project profile saved'));
    },
    [load, selectedProjectId, t],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  return (
    <ProjectProfileBinding
      projectName={selectedProject?.name ?? selectedProjectId ?? ''}
      profiles={profiles}
      bindingProfileId={bindingProfileId}
      bindingSaving={bindingSaving}
      onBindingChange={updateBinding}
    />
  );
}

function ProjectProfileBinding({
  projectName,
  profiles,
  bindingProfileId,
  bindingSaving,
  onBindingChange,
}: {
  projectName: string;
  profiles: AgentExecutionProfileResponse[];
  bindingProfileId: string | null;
  bindingSaving: boolean;
  onBindingChange: (value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">
          {t('agentProfiles.projectProfile', 'Project profile')}
        </h3>
        <p className="text-muted-foreground text-xs">{projectName}</p>
      </div>
      <div className="border-border/50 rounded-lg border p-4">
        <Select
          value={bindingProfileId ?? NO_PROFILE_VALUE}
          onValueChange={onBindingChange}
          disabled={bindingSaving}
        >
          <SelectTrigger className="w-full max-w-md" data-testid="agent-profile-project-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PROFILE_VALUE}>
              {t('agentProfiles.noProjectProfile', 'Default Claude profile')}
            </SelectItem>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

function CreateProfileForm({
  draft,
  creating,
  onDraftChange,
  onSubmit,
}: {
  draft: ProfileDraft;
  creating: boolean;
  onDraftChange: Dispatch<SetStateAction<ProfileDraft>>;
  onSubmit: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();

  return (
    <form
      onSubmit={onSubmit}
      className="border-border/50 grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
    >
      <LabeledInput
        id="agent-profile-new-name"
        label={t('agentProfiles.name', 'Name')}
        value={draft.name}
        onChange={(value) => onDraftChange((current) => ({ ...current, name: value }))}
        placeholder={t('agentProfiles.namePlaceholder', 'Work Claude')}
        data-testid="agent-profile-create-name"
      />
      <LabeledInput
        id="agent-profile-new-config-dir"
        label={t('agentProfiles.configDir', 'CLAUDE_CONFIG_DIR')}
        value={draft.configDir}
        onChange={(value) => onDraftChange((current) => ({ ...current, configDir: value }))}
        placeholder="~/.claude-work"
        className="font-mono"
        data-testid="agent-profile-create-config-dir"
      />
      <div className="flex items-end">
        <Button
          type="submit"
          size="sm"
          className="w-full sm:w-auto"
          disabled={creating}
          data-testid="agent-profile-create"
        >
          <Plus className="icon-sm mr-1.5" />
          {t('common.create', 'Create')}
        </Button>
      </div>
      <ClaudeAuthCommand configDir={draft.configDir} className="sm:col-span-3" />
    </form>
  );
}

function LabeledInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  className,
  'data-testid': testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <label htmlFor={id} className="grid gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn('h-8 text-sm', className)}
        data-testid={testId}
      />
    </label>
  );
}

function ProfileEditor({
  profile,
  draft,
  saving,
  onDraftChange,
  onSave,
  onDelete,
}: {
  profile: AgentExecutionProfileResponse;
  draft: ProfileDraft;
  saving: boolean;
  onDraftChange: (id: string, field: keyof ProfileDraft, value: string) => void;
  onSave: (profile: AgentExecutionProfileResponse) => void;
  onDelete: (profile: AgentExecutionProfileResponse) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="border-border/50 grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
      data-testid={`agent-profile-${profile.id}`}
    >
      <LabeledInput
        id={`agent-profile-${profile.id}-name`}
        label={t('agentProfiles.name', 'Name')}
        value={draft.name}
        onChange={(value) => onDraftChange(profile.id, 'name', value)}
        data-testid={`agent-profile-${profile.id}-name`}
      />
      <LabeledInput
        id={`agent-profile-${profile.id}-config-dir`}
        label={t('agentProfiles.configDir', 'CLAUDE_CONFIG_DIR')}
        value={draft.configDir}
        onChange={(value) => onDraftChange(profile.id, 'configDir', value)}
        className="font-mono"
        data-testid={`agent-profile-${profile.id}-config-dir`}
      />
      <div className="flex items-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onSave(profile)}
          disabled={saving}
          data-testid={`agent-profile-${profile.id}-save`}
        >
          <Save className="icon-sm mr-1.5" />
          {t('common.save', 'Save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onDelete(profile)}
          disabled={saving}
          aria-label={t('common.delete', 'Delete')}
          data-testid={`agent-profile-${profile.id}-delete`}
        >
          <Trash2 className="icon-sm" />
        </Button>
      </div>
      <ClaudeAuthCommand configDir={draft.configDir} className="sm:col-span-3" />
    </div>
  );
}

function ClaudeAuthCommand({ configDir, className }: { configDir: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, copy] = useCopyToClipboard();
  const command = buildClaudeAuthCommand(configDir);
  const hasConfigDir = configDir.trim().length > 0;

  return (
    <div className={cn('grid gap-1.5', className)}>
      <span className="text-muted-foreground text-xs font-medium">
        {t('agentProfiles.authCommand', 'Subscription login command')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="bg-muted text-foreground min-w-0 flex-1 truncate rounded px-3 py-2 font-mono text-xs"
          data-testid="agent-profile-auth-command"
        >
          {command}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => copy(command)}
          disabled={!hasConfigDir}
          aria-label={t('agentProfiles.copyAuthCommand', 'Copy subscription login command')}
          data-testid="agent-profile-copy-auth-command"
        >
          {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
        </Button>
      </div>
    </div>
  );
}

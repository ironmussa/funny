/**
 * A project's secrets (openspec project-secrets): named values the project's
 * agents receive as environment variables. Two lists: the secrets the members
 * share (an admin changes them) and the caller's own, which take the place of
 * a shared secret of the same name for the caller's agents.
 *
 * A value is typed here and never shown again: the server answers names and
 * settings only, so replacing a secret starts from an empty field.
 */
import {
  secretNameMessage,
  secretValueMessage,
  validateSecretName,
  validateSecretValue,
} from '@funny/shared/project-secrets';
import { Eye, EyeOff, Plus, ShieldAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { deleteProjectSecret, setProjectSecret } from '@/data/project-secrets/actions';
import { useProjectSecrets } from '@/data/project-secrets/hooks';
import { useCanManageProject, useCanSteerProject } from '@/data/projects/hooks';
import type { ProjectSecretSummary } from '@/lib/api/project-secrets';
import { toastError } from '@/lib/toast-error';

type Scope = ProjectSecretSummary['scope'];

/** What the dialog edits: a new secret of a scope, or a stored one being replaced. */
type Editing = { mode: 'add'; scope: Scope } | { mode: 'replace'; secret: ProjectSecretSummary };

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/** Names present in both lists: the personal one is what the caller's agents get. */
function overriddenNames(secrets: ProjectSecretSummary[]): Set<string> {
  const personal = new Set<string>();
  for (const secret of secrets) if (secret.scope === 'user') personal.add(secret.name);
  const both = new Set<string>();
  for (const secret of secrets) {
    if (secret.scope === 'project' && personal.has(secret.name)) both.add(secret.name);
  }
  return both;
}

function SecretRow({
  secret,
  overridden,
  canWrite,
  busy,
  onSandbox,
  onReplace,
  onDelete,
}: {
  secret: ProjectSecretSummary;
  /** The other list holds a secret of this name. */
  overridden: boolean;
  canWrite: boolean;
  busy: boolean;
  onSandbox: (allow: boolean) => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const key = `${secret.scope}-${secret.name}`;
  return (
    <li
      className="border-border/50 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
      data-testid={`settings-secret-row-${key}`}
    >
      <div className="min-w-0">
        <p className="text-foreground flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="font-mono break-all">{secret.name}</span>
          {overridden && (
            <Badge variant="outline" data-testid={`settings-secret-override-${key}`}>
              {secret.scope === 'user'
                ? t('projectSecrets.overridesShared', 'Overrides shared')
                : t('projectSecrets.overriddenByYours', 'Overridden by yours')}
            </Badge>
          )}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t('projectSecrets.updatedOn', 'Updated {{date}}', {
            date: formatDate(secret.updatedAt),
          })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          {t('projectSecrets.sandbox', 'Sandboxes')}
          <Switch
            checked={secret.allowInSandbox}
            disabled={!canWrite || busy}
            onCheckedChange={onSandbox}
            aria-label={t('projectSecrets.sandboxLabel', 'Give {{name}} to sandbox agents', {
              name: secret.name,
            })}
            data-testid={`settings-secret-sandbox-${key}`}
          />
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite || busy}
          onClick={onReplace}
          data-testid={`settings-secret-replace-${key}`}
        >
          {t('projectSecrets.replace', 'Replace')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite || busy}
          onClick={onDelete}
          data-testid={`settings-secret-delete-${key}`}
        >
          {t('common.delete', 'Delete')}
        </Button>
      </div>
    </li>
  );
}

function SecretList({
  scope,
  title,
  description,
  secrets,
  overridden,
  canWrite,
  busy,
  onAdd,
  onSandbox,
  onReplace,
  onDelete,
}: {
  scope: Scope;
  title: string;
  description: string;
  secrets: ProjectSecretSummary[];
  overridden: Set<string>;
  canWrite: boolean;
  busy: boolean;
  onAdd: () => void;
  onSandbox: (secret: ProjectSecretSummary, allow: boolean) => void;
  onReplace: (secret: ProjectSecretSummary) => void;
  onDelete: (secret: ProjectSecretSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3" data-testid={`settings-secrets-list-${scope}`}>
      <div className="flex items-end justify-between gap-3 px-1 pb-2">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">{title}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite}
          onClick={onAdd}
          data-testid={`settings-secret-add-${scope}`}
        >
          <Plus className="icon-sm" />
          {t('projectSecrets.add', 'Add secret')}
        </Button>
      </div>
      <div className="border-border/50 overflow-hidden rounded-lg border">
        {secrets.length === 0 ? (
          <p
            className="text-muted-foreground px-4 py-3 text-xs"
            data-testid={`settings-secrets-empty-${scope}`}
          >
            {t('projectSecrets.empty', 'No secrets yet.')}
          </p>
        ) : (
          <ul>
            {secrets.map((secret) => (
              <SecretRow
                key={secret.id}
                secret={secret}
                overridden={overridden.has(secret.name)}
                canWrite={canWrite}
                busy={busy}
                onSandbox={(allow) => onSandbox(secret, allow)}
                onReplace={() => onReplace(secret)}
                onDelete={() => onDelete(secret)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Attributes that keep password managers from offering to fill or save the value. */
const NO_PASSWORD_MANAGER = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
} as const;

/**
 * The value of a secret: masked while typed, or a plain multi-line box for
 * values such as PEM keys. `stored` says a value exists already, so an empty
 * field keeps it.
 */
function SecretValueField({
  id,
  value,
  stored,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  stored: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [multiline, setMultiline] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const problem = value === '' ? null : validateSecretValue(value);
  const shared = {
    id,
    value,
    disabled,
    placeholder: stored
      ? t('projectSecrets.storedPlaceholder', 'Stored, type a new value to replace')
      : undefined,
    'aria-invalid': problem ? true : undefined,
    'data-testid': 'settings-secret-value',
    ...NO_PASSWORD_MANAGER,
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-foreground text-xs font-medium">
          {t('projectSecrets.value', 'Value')}
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          {t('projectSecrets.multiline', 'Multi-line')}
          <Switch
            checked={multiline}
            disabled={disabled}
            onCheckedChange={setMultiline}
            data-testid="settings-secret-multiline"
          />
        </label>
      </div>
      {multiline ? (
        <>
          <Textarea {...shared} rows={6} onChange={(e) => onChange(e.target.value)} />
          <p className="text-muted-foreground text-xs" data-testid="settings-secret-unmasked">
            {t('projectSecrets.multilineUnmasked', 'A multi-line value is shown as you type.')}
          </p>
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            {...shared}
            // A CSS-masked text field would still expose the value to screen readers.
            type={revealed ? 'text' : 'password'}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-pressed={revealed}
            aria-label={
              revealed
                ? t('projectSecrets.hideValue', 'Hide value')
                : t('projectSecrets.showValue', 'Show value')
            }
            onClick={() => setRevealed((current) => !current)}
            data-testid="settings-secret-reveal"
          >
            {revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
          </Button>
        </div>
      )}
      {problem && (
        <p className="text-destructive text-xs" data-testid="settings-secret-value-error">
          {t(`projectSecrets.valueProblem.${problem}`, secretValueMessage(problem))}
        </p>
      )}
    </div>
  );
}

function SecretDialog({
  projectId,
  editing,
  onClose,
}: {
  projectId: string;
  editing: Editing;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const replacing = editing.mode === 'replace' ? editing.secret : null;
  const scope = replacing?.scope ?? (editing.mode === 'add' ? editing.scope : 'user');

  const [name, setName] = useState(replacing?.name ?? '');
  const [value, setValue] = useState('');
  const [allowInSandbox, setAllowInSandbox] = useState(replacing?.allowInSandbox ?? false);
  const [saving, setSaving] = useState(false);

  const nameProblem = name === '' ? null : validateSecretName(name);
  const valueProblem = value === '' ? null : validateSecretValue(value);
  // A stored secret keeps its value when the field is left empty.
  const valueMissing = value === '' && !replacing;
  const canSave = name !== '' && !nameProblem && !valueProblem && !valueMissing && !saving;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    let result;
    try {
      result = await setProjectSecret({
        projectId,
        scope,
        name,
        allowInSandbox,
        ...(value !== '' && { value }),
      });
    } finally {
      setSaving(false);
    }
    if (result.isErr()) {
      // The typed value stays so it can be sent again.
      toastError(result.error, 'projectSecrets');
      return;
    }
    // Emptied before the dialog closes, so the browser does not offer to save a login.
    setValue('');
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent data-testid="settings-secret-dialog">
        <DialogHeader>
          <DialogTitle>
            {replacing
              ? t('projectSecrets.replaceTitle', 'Replace {{name}}', { name: replacing.name })
              : scope === 'project'
                ? t('projectSecrets.addSharedTitle', 'Add a shared secret')
                : t('projectSecrets.addPersonalTitle', 'Add a personal secret')}
          </DialogTitle>
          <DialogDescription>
            {scope === 'project'
              ? t(
                  'projectSecrets.sharedDialogDesc',
                  'Every member who can start threads on this project gets it in their agents.',
                )
              : t(
                  'projectSecrets.personalDialogDesc',
                  'Only the agents of your own threads on this project get it.',
                )}
          </DialogDescription>
        </DialogHeader>

        <form id={formId} className="flex flex-col gap-3" onSubmit={submit} autoComplete="off">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-name`} className="text-foreground text-xs font-medium">
              {t('projectSecrets.name', 'Name')}
            </label>
            <Input
              id={`${formId}-name`}
              value={name}
              // The name is the secret's key: renaming is deleting and adding.
              readOnly={!!replacing}
              disabled={saving}
              placeholder="DATABASE_URL"
              aria-invalid={nameProblem ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              data-testid="settings-secret-name"
              {...NO_PASSWORD_MANAGER}
            />
            {nameProblem && (
              <p className="text-destructive text-xs" data-testid="settings-secret-name-error">
                {t(`projectSecrets.nameProblem.${nameProblem}`, secretNameMessage(nameProblem))}
              </p>
            )}
          </div>

          <SecretValueField
            id={`${formId}-value`}
            value={value}
            stored={!!replacing}
            disabled={saving}
            onChange={setValue}
          />

          <label className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-medium">
                {t('projectSecrets.sandboxTitle', 'Available in sandboxes')}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {t(
                  'projectSecrets.sandboxDesc',
                  'A sandbox agent can read whatever it receives, and so can anyone you share the thread with as an editor.',
                )}
              </span>
            </span>
            <Switch
              checked={allowInSandbox}
              disabled={saving}
              onCheckedChange={setAllowInSandbox}
              data-testid="settings-secret-allow-sandbox"
            />
          </label>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
            data-testid="settings-secret-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!canSave}
            data-testid="settings-secret-save"
          >
            {t('projectSecrets.save', 'Save secret')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What deleting `secret` changes for the agents, said before it happens. */
function useDeleteDescription(secret: ProjectSecretSummary | null, overridden: Set<string>) {
  const { t } = useTranslation();
  if (!secret) return '';
  const base = t(
    'projectSecrets.deleteDescription',
    'Agents started from now on will not get {{name}}.',
    { name: secret.name },
  );
  if (secret.scope === 'user' && overridden.has(secret.name)) {
    return t(
      'projectSecrets.deleteOverrideDescription',
      'Your agents will get the shared value of {{name}} again.',
      { name: secret.name },
    );
  }
  return base;
}

export function ProjectSecretsSetting({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const secrets = useProjectSecrets(projectId);
  const canManage = useCanManageProject(projectId);
  const canSteer = useCanSteerProject(projectId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ProjectSecretSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const all = secrets ?? [];
  const overridden = overriddenNames(all);
  const deleteDescription = useDeleteDescription(deleting, overridden);

  const setSandbox = async (secret: ProjectSecretSummary, allowInSandbox: boolean) => {
    setBusy(true);
    try {
      // No value: the stored one is kept.
      const result = await setProjectSecret({
        projectId,
        scope: secret.scope,
        name: secret.name,
        allowInSandbox,
      });
      if (result.isErr()) toastError(result.error, 'projectSecrets');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const result = await deleteProjectSecret(projectId, deleting.id);
      if (result.isErr()) toastError(result.error, 'projectSecrets');
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const listProps = {
    overridden,
    busy,
    onSandbox: setSandbox,
    onReplace: (secret: ProjectSecretSummary) => setEditing({ mode: 'replace', secret }),
    onDelete: setDeleting,
  };

  return (
    <section className="mt-6" data-testid="settings-secrets-section">
      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-semibold tracking-wider uppercase">
        {t('projectSecrets.title', 'Secrets')}
      </h3>
      <p className="text-muted-foreground px-1 pb-2 text-xs">
        {t(
          'projectSecrets.description',
          'Values the agents of this project get as environment variables. A value is stored encrypted and is never shown again here.',
        )}
      </p>

      <div className="mb-3">
        <Alert data-testid="settings-secrets-notice">
          <ShieldAlert className="icon-base" />
          <AlertDescription>
            <span className="block" data-testid="settings-secrets-notice-readers">
              {t(
                'projectSecrets.noticeReaders',
                'Anyone who can start threads on this project can read a shared secret through their agent, and so can someone you share a thread with as an editor.',
              )}
            </span>
            <span className="mt-1 block" data-testid="settings-secrets-notice-redaction">
              {t(
                'projectSecrets.noticeRedaction',
                'Values an agent prints are replaced with [secret:NAME] in what is saved and shown, as a best effort: the model still sees them, and an encoded or split value is not caught.',
              )}
            </span>
          </AlertDescription>
        </Alert>
      </div>

      <SecretList
        {...listProps}
        scope="project"
        title={t('projectSecrets.shared', 'Shared')}
        description={t(
          'projectSecrets.sharedDesc',
          'For every member. Only a project admin can change them.',
        )}
        secrets={all.filter((secret) => secret.scope === 'project')}
        canWrite={canManage}
        onAdd={() => setEditing({ mode: 'add', scope: 'project' })}
      />
      <SecretList
        {...listProps}
        scope="user"
        title={t('projectSecrets.mine', 'Mine')}
        description={t(
          'projectSecrets.mineDesc',
          'Only for your threads. One with the name of a shared secret takes its place.',
        )}
        secrets={all.filter((secret) => secret.scope === 'user')}
        canWrite={canSteer}
        onAdd={() => setEditing({ mode: 'add', scope: 'user' })}
      />

      {editing && (
        <SecretDialog projectId={projectId} editing={editing} onClose={() => setEditing(null)} />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('projectSecrets.deleteTitle', 'Delete {{name}}?', { name: deleting?.name ?? '' })}
        description={deleteDescription}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmLabel={t('common.delete', 'Delete')}
        loading={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

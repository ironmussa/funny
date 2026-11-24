import { Plus, Trash2, FileText, Network, Terminal } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';

import type { ProjectConfigState } from './use-project-config';

export function EnvFilesSection({ state }: { state: ProjectConfigState }) {
  const { t, config, newEnvFile, setNewEnvFile, addEnvFile, updateEnvFile, removeEnvFile } = state;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <FileText className="icon-base text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('projectConfig.envFiles')}</h3>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">{t('projectConfig.envFilesDescription')}</p>

      <div className="space-y-1.5">
        {(config.envFiles ?? []).map((file, i) => (
          <div key={file} className="group flex items-center gap-2" data-testid={`env-file-${i}`}>
            <Input
              mono
              className="flex-1"
              defaultValue={file}
              onBlur={(e) => updateEnvFile(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              data-testid={`env-file-edit-${i}`}
            />
            <TooltipIconButton
              variant="muted-destructive"
              onClick={() => removeEnvFile(i)}
              className="opacity-0 group-hover:opacity-100"
              data-testid={`env-file-remove-${i}`}
              tooltip={t('common.delete')}
            >
              <Trash2 className="icon-xs" />
            </TooltipIconButton>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Input
          mono
          className="flex-1"
          placeholder={t('projectConfig.envFilePlaceholder')}
          value={newEnvFile}
          onChange={(e) => setNewEnvFile(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addEnvFile()}
          data-testid="env-file-input"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={addEnvFile}
          data-testid="env-file-add"
        >
          <Plus className="icon-sm" />
        </Button>
      </div>
    </section>
  );
}

export function PortGroupsSection({ state }: { state: ProjectConfigState }) {
  const {
    t,
    config,
    addingGroup,
    setAddingGroup,
    groupName,
    setGroupName,
    groupPort,
    setGroupPort,
    groupEnvVar,
    setGroupEnvVar,
    addPortGroup,
    removePortGroup,
    updatePortGroup,
    addEnvVarToGroup,
    removeEnvVarFromGroup,
  } = state;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Network className="icon-base text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('projectConfig.portGroups')}</h3>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {t('projectConfig.portGroupsDescription')}
      </p>

      <div className="space-y-3">
        {(config.portGroups ?? []).map((group, gi) => (
          <div
            key={gi}
            className="group border-border/50 bg-card rounded-lg border p-3"
            data-testid={`port-group-${gi}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Input
                  size="xs"
                  className="w-32 text-sm font-medium"
                  defaultValue={group.name}
                  onBlur={(e) => updatePortGroup(gi, 'name', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  data-testid={`port-group-${gi}-name`}
                />
                <Input
                  mono
                  size="xs"
                  className="w-20"
                  type="number"
                  defaultValue={group.basePort}
                  onBlur={(e) => updatePortGroup(gi, 'basePort', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  data-testid={`port-group-${gi}-port`}
                />
              </div>
              <TooltipIconButton
                variant="muted-destructive"
                onClick={() => removePortGroup(gi)}
                className="opacity-0 group-hover:opacity-100"
                data-testid={`port-group-remove-${gi}`}
                tooltip={t('common.delete')}
              >
                <Trash2 className="icon-xs" />
              </TooltipIconButton>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {group.envVars.map((v, vi) => (
                <Badge
                  size="xs"
                  key={vi}
                  variant="outline"
                  className="hover:bg-destructive/10 hover:text-status-error cursor-pointer font-mono"
                  onClick={() => removeEnvVarFromGroup(gi, vi)}
                  data-testid={`port-group-${gi}-var-${vi}`}
                >
                  {v}
                  <Trash2 className="icon-2xs" />
                </Badge>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  mono
                  size="xs"
                  className="h-6 w-32"
                  placeholder={t('projectConfig.envVarPlaceholder')}
                  value={groupEnvVar}
                  onChange={(e) => setGroupEnvVar(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') addEnvVarToGroup(gi);
                  }}
                  data-testid={`port-group-${gi}-var-input`}
                />
                <TooltipIconButton
                  onClick={() => addEnvVarToGroup(gi)}
                  data-testid={`port-group-${gi}-var-add`}
                  tooltip={t('common.add')}
                >
                  <Plus className="icon-xs" />
                </TooltipIconButton>
              </div>
            </div>
          </div>
        ))}
      </div>

      {addingGroup ? (
        <div className="mt-3 flex items-center gap-2">
          <Input
            className="h-8 flex-1 text-sm"
            placeholder={t('projectConfig.groupNamePlaceholder')}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            data-testid="port-group-name-input"
            autoFocus
          />
          <Input
            mono
            className="w-24"
            type="number"
            placeholder={t('projectConfig.portPlaceholder')}
            value={groupPort}
            onChange={(e) => setGroupPort(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addPortGroup()}
            data-testid="port-group-port-input"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={addPortGroup}
            data-testid="port-group-add-confirm"
          >
            <Plus className="icon-sm" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setAddingGroup(false);
              setGroupName('');
              setGroupPort('');
            }}
            data-testid="port-group-add-cancel"
          >
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 gap-1.5"
          onClick={() => setAddingGroup(true)}
          data-testid="port-group-add"
        >
          <Plus className="icon-sm" />
          {t('projectConfig.addPortGroup')}
        </Button>
      )}
    </section>
  );
}

export function PostCreateSection({ state }: { state: ProjectConfigState }) {
  const {
    t,
    config,
    newPostCreate,
    setNewPostCreate,
    addPostCreate,
    updatePostCreate,
    removePostCreate,
  } = state;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Terminal className="icon-base text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('projectConfig.postCreate')}</h3>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {t('projectConfig.postCreateDescription')}
      </p>

      <div className="space-y-1.5">
        {(config.postCreate ?? []).map((cmd, i) => (
          <div key={cmd} className="group flex items-center gap-2" data-testid={`post-create-${i}`}>
            <Input
              mono
              className="flex-1"
              defaultValue={cmd}
              onBlur={(e) => updatePostCreate(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              data-testid={`post-create-edit-${i}`}
            />
            <Button
              variant="muted-destructive"
              size="icon-xs"
              onClick={() => removePostCreate(i)}
              className="opacity-0 group-hover:opacity-100"
              data-testid={`post-create-remove-${i}`}
            >
              <Trash2 className="icon-xs" />
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Input
          mono
          className="flex-1"
          placeholder={t('projectConfig.postCreatePlaceholder')}
          value={newPostCreate}
          onChange={(e) => setNewPostCreate(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPostCreate()}
          data-testid="post-create-input"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={addPostCreate}
          data-testid="post-create-add"
        >
          <Plus className="icon-sm" />
        </Button>
      </div>
    </section>
  );
}

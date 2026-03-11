import type { FunnyProjectConfig, FunnyPortGroup } from '@funny/shared';
import { Plus, Trash2, FileText, Network, Terminal } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

export function ProjectConfigSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [config, setConfig] = useState<FunnyProjectConfig>({});
  const [loading, setLoading] = useState(true);

  // ── Env Files state ──
  const [newEnvFile, setNewEnvFile] = useState('');

  // ── Port Groups state ──
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupPort, setGroupPort] = useState('');
  const [groupEnvVar, setGroupEnvVar] = useState('');

  // ── Post Create state ──
  const [newPostCreate, setNewPostCreate] = useState('');

  const loadConfig = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    const result = await api.getProjectConfig(selectedProjectId);
    if (result.isOk()) {
      setConfig(result.value);
    }
    setLoading(false);
  }, [selectedProjectId]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const saveConfig = async (updated: FunnyProjectConfig) => {
    if (!selectedProjectId) return;
    const result = await api.updateProjectConfig(selectedProjectId, updated);
    if (result.isOk()) {
      setConfig(updated);
      toast.success(t('projectConfig.saved'));
    } else {
      toast.error(t('projectConfig.saveError'));
    }
  };

  // ── Env Files handlers ──
  const addEnvFile = () => {
    if (!newEnvFile.trim()) return;
    const envFiles = [...(config.envFiles ?? []), newEnvFile.trim()];
    saveConfig({ ...config, envFiles });
    setNewEnvFile('');
  };

  const updateEnvFile = (index: number, value: string) => {
    const envFiles = [...(config.envFiles ?? [])];
    if (!value.trim()) {
      envFiles.splice(index, 1);
    } else {
      envFiles[index] = value.trim();
    }
    saveConfig({ ...config, envFiles });
  };

  const removeEnvFile = (index: number) => {
    const envFiles = (config.envFiles ?? []).filter((_, i) => i !== index);
    saveConfig({ ...config, envFiles });
  };

  // ── Port Groups handlers ──
  const addPortGroup = () => {
    if (!groupName.trim() || !groupPort.trim()) return;
    const newGroup: FunnyPortGroup = {
      name: groupName.trim(),
      basePort: parseInt(groupPort, 10),
      envVars: [],
    };
    const portGroups = [...(config.portGroups ?? []), newGroup];
    saveConfig({ ...config, portGroups });
    setGroupName('');
    setGroupPort('');
    setAddingGroup(false);
  };

  const removePortGroup = (index: number) => {
    const portGroups = (config.portGroups ?? []).filter((_, i) => i !== index);
    saveConfig({ ...config, portGroups });
  };

  const updatePortGroup = (index: number, field: 'name' | 'basePort', value: string) => {
    const portGroups = [...(config.portGroups ?? [])];
    const group = { ...portGroups[index] };
    if (field === 'name') {
      if (!value.trim()) return;
      group.name = value.trim();
    } else {
      const port = parseInt(value, 10);
      if (isNaN(port)) return;
      group.basePort = port;
    }
    portGroups[index] = group;
    saveConfig({ ...config, portGroups });
  };

  const addEnvVarToGroup = (groupIndex: number) => {
    if (!groupEnvVar.trim()) return;
    const portGroups = [...(config.portGroups ?? [])];
    const group = { ...portGroups[groupIndex] };
    group.envVars = [...group.envVars, groupEnvVar.trim()];
    portGroups[groupIndex] = group;
    saveConfig({ ...config, portGroups });
    setGroupEnvVar('');
  };

  const removeEnvVarFromGroup = (groupIndex: number, varIndex: number) => {
    const portGroups = [...(config.portGroups ?? [])];
    const group = { ...portGroups[groupIndex] };
    group.envVars = group.envVars.filter((_, i) => i !== varIndex);
    portGroups[groupIndex] = group;
    saveConfig({ ...config, portGroups });
  };

  // ── Post Create handlers ──
  const addPostCreate = () => {
    if (!newPostCreate.trim()) return;
    const postCreate = [...(config.postCreate ?? []), newPostCreate.trim()];
    saveConfig({ ...config, postCreate });
    setNewPostCreate('');
  };

  const updatePostCreate = (index: number, value: string) => {
    const postCreate = [...(config.postCreate ?? [])];
    if (!value.trim()) {
      postCreate.splice(index, 1);
    } else {
      postCreate[index] = value.trim();
    }
    saveConfig({ ...config, postCreate });
  };

  const removePostCreate = (index: number) => {
    const postCreate = (config.postCreate ?? []).filter((_, i) => i !== index);
    saveConfig({ ...config, postCreate });
  };

  if (!selectedProjectId) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t('projectConfig.noProject')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Env Files ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('projectConfig.envFiles')}</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('projectConfig.envFilesDescription')}
        </p>

        <div className="space-y-1.5">
          {(config.envFiles ?? []).map((file, i) => (
            <div key={i} className="group flex items-center gap-2" data-testid={`env-file-${i}`}>
              <Input
                className="h-8 flex-1 font-mono text-sm"
                defaultValue={file}
                onBlur={(e) => updateEnvFile(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                data-testid={`env-file-edit-${i}`}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeEnvFile(i)}
                className="text-muted-foreground opacity-0 hover:text-status-error group-hover:opacity-100"
                data-testid={`env-file-remove-${i}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Input
            className="h-8 flex-1 font-mono text-sm"
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
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </section>

      <Separator />

      {/* ── Port Groups ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('projectConfig.portGroups')}</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('projectConfig.portGroupsDescription')}
        </p>

        <div className="space-y-3">
          {(config.portGroups ?? []).map((group, gi) => (
            <div
              key={gi}
              className="group rounded-lg border border-border/50 bg-card p-3"
              data-testid={`port-group-${gi}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-7 w-32 text-sm font-medium"
                    defaultValue={group.name}
                    onBlur={(e) => updatePortGroup(gi, 'name', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    data-testid={`port-group-${gi}-name`}
                  />
                  <Input
                    className="h-7 w-20 font-mono text-xs"
                    type="number"
                    defaultValue={group.basePort}
                    onBlur={(e) => updatePortGroup(gi, 'basePort', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    data-testid={`port-group-${gi}-port`}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removePortGroup(gi)}
                  className="text-muted-foreground opacity-0 hover:text-status-error group-hover:opacity-100"
                  data-testid={`port-group-remove-${gi}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {group.envVars.map((v, vi) => (
                  <Badge
                    key={vi}
                    variant="outline"
                    className="cursor-pointer gap-1 font-mono text-xs hover:bg-destructive/10 hover:text-status-error"
                    onClick={() => removeEnvVarFromGroup(gi, vi)}
                    data-testid={`port-group-${gi}-var-${vi}`}
                  >
                    {v}
                    <Trash2 className="h-2.5 w-2.5" />
                  </Badge>
                ))}
                <div className="flex items-center gap-1">
                  <Input
                    className="h-6 w-32 font-mono text-xs"
                    placeholder={t('projectConfig.envVarPlaceholder')}
                    value={groupEnvVar}
                    onChange={(e) => setGroupEnvVar(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addEnvVarToGroup(gi);
                    }}
                    data-testid={`port-group-${gi}-var-input`}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => addEnvVarToGroup(gi)}
                    data-testid={`port-group-${gi}-var-add`}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
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
              className="h-8 w-24 font-mono text-sm"
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
              <Plus className="h-3.5 w-3.5" />
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
            <Plus className="h-3.5 w-3.5" />
            {t('projectConfig.addPortGroup')}
          </Button>
        )}
      </section>

      <Separator />

      {/* ── Post Create ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('projectConfig.postCreate')}</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('projectConfig.postCreateDescription')}
        </p>

        <div className="space-y-1.5">
          {(config.postCreate ?? []).map((cmd, i) => (
            <div key={i} className="group flex items-center gap-2" data-testid={`post-create-${i}`}>
              <Input
                className="h-8 flex-1 font-mono text-sm"
                defaultValue={cmd}
                onBlur={(e) => updatePostCreate(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                data-testid={`post-create-edit-${i}`}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removePostCreate(i)}
                className="text-muted-foreground opacity-0 hover:text-status-error group-hover:opacity-100"
                data-testid={`post-create-remove-${i}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Input
            className="h-8 flex-1 font-mono text-sm"
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
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </section>
    </div>
  );
}

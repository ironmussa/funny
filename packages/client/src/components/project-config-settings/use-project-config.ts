import type { FunnyProjectConfig, FunnyPortGroup } from '@funny/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

/** The selected project's `.funny.json` config, its drafts and its edit handlers. */
export function useProjectConfigSettings() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const [config, setConfig] = useState<FunnyProjectConfig>({});
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  // ── Env Files state ──
  const [newEnvFile, setNewEnvFile] = useState('');

  // ── Port Groups state ──
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupPort, setGroupPort] = useState('');
  const [groupEnvVar, setGroupEnvVar] = useState('');

  // ── Post Create state ──
  const [newPostCreate, setNewPostCreate] = useState('');

  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    void (async () => {
      const result = await api.getProjectConfig(selectedProjectId);
      if (cancelled) return;
      if (result.isOk()) setConfig(result.value);
      setLoadedProjectId(selectedProjectId);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const loading = loadedProjectId !== selectedProjectId;

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

  return {
    t,
    selectedProjectId,
    config,
    loading,
    newEnvFile,
    setNewEnvFile,
    addingGroup,
    setAddingGroup,
    groupName,
    setGroupName,
    groupPort,
    setGroupPort,
    groupEnvVar,
    setGroupEnvVar,
    newPostCreate,
    setNewPostCreate,
    addEnvFile,
    updateEnvFile,
    removeEnvFile,
    addPortGroup,
    removePortGroup,
    updatePortGroup,
    addEnvVarToGroup,
    removeEnvVarFromGroup,
    addPostCreate,
    updatePostCreate,
    removePostCreate,
  };
}

export type ProjectConfigState = ReturnType<typeof useProjectConfigSettings>;

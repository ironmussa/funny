import { isPromptModelConfigurable, type ModelSelectGroup } from '@/lib/providers';

export function getConfigurablePromptModelGroups(
  modelGroups: ModelSelectGroup[],
): ModelSelectGroup[] {
  const groups: ModelSelectGroup[] = [];

  for (const group of modelGroups) {
    if (group.disabled) continue;

    const models = group.models.filter((model) => isPromptModelConfigurable(model.value));
    if (models.length === 0) continue;

    groups.push({ ...group, models });
  }

  return groups;
}

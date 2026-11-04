import type {
  AgentTemplate,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, type ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import { agentTemplatesApi } from '@/lib/api/agent-templates';
import { clientComposition } from '@/platform/client-composition';

import type { DataLayer } from '../data-layer';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';
import { TEMPLATE_USAGE_KEY } from './loaders';
import { getTemplatesData, prependPositions } from './store';

/**
 * Agent template writes. Edits and deletes are optimistic (`optimistic-write.ts`);
 * creating or duplicating needs the server's id, so the new template appears
 * once the server answers, at the top of the list.
 */

const UPDATE_FAILED = 'errors.templateUpdateFailed';

function missing(templateId: string): ResultAsync<never, DomainError> {
  return errAsync({ type: 'NOT_FOUND', message: `Template ${templateId} is not loaded` });
}

/** Insert a template the server just created, at the top of the list. */
function addCreated(
  result: ResultAsync<AgentTemplate, DomainError>,
  layer: DataLayer,
): ResultAsync<AgentTemplate, DomainError> {
  const data = getTemplatesData(layer);
  return result
    .map((template) => {
      prependPositions(data, [template.id]);
      data.upsert([template]);
      return template;
    })
    .mapErr((error) => {
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'error',
        message: i18n.t('errors.templateCreateFailed'),
        description: error.friendlyMessage ?? i18n.t(`errors.generic.${error.type}`),
      });
      return error;
    });
}

export function createTemplate(
  request: CreateAgentTemplateRequest,
  layer: DataLayer = getDataLayer(),
): ResultAsync<AgentTemplate, DomainError> {
  return addCreated(agentTemplatesApi.createAgentTemplate(request), layer);
}

export function duplicateTemplate(
  templateId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<AgentTemplate, DomainError> {
  return addCreated(agentTemplatesApi.duplicateAgentTemplate(templateId), layer);
}

export function updateTemplate(
  templateId: string,
  fields: UpdateAgentTemplateRequest,
  layer: DataLayer = getDataLayer(),
): ResultAsync<AgentTemplate, DomainError> {
  const data = getTemplatesData(layer);
  if (!data.collection.has(templateId)) return missing(templateId);
  return optimisticWrite({
    entity: 'agent-templates',
    operation: 'update',
    apply: () =>
      data.collection.update(templateId, (draft) => {
        Object.assign(draft, fields);
      }),
    persist: () => agentTemplatesApi.updateAgentTemplate(templateId, fields),
    confirm: (template) => data.upsert([template]),
    failureMessageKey: UPDATE_FAILED,
  });
}

export function deleteTemplate(
  templateId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getTemplatesData(layer);
  if (!data.collection.has(templateId)) return missing(templateId);
  return optimisticWrite({
    entity: 'agent-templates',
    operation: 'delete',
    apply: () => data.collection.delete(templateId),
    persist: () => agentTemplatesApi.deleteAgentTemplate(templateId),
    confirm: () => {
      data.remove([templateId]);
      data.position.delete(templateId);
      void layer.queryClient.invalidateQueries({ queryKey: TEMPLATE_USAGE_KEY });
    },
    failureMessageKey: UPDATE_FAILED,
  });
}

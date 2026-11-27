import type {
  Automation,
  CreateAutomationRequest,
  RunTriageStatus,
  UpdateAutomationRequest,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import { automationsApi } from '@/lib/api/automations';
import { clientComposition } from '@/platform/client-composition';

import type { DataLayer } from '../data-layer';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';
import { getAutomationsData, getInboxData, getRunsData } from './store';

/**
 * Automation writes. Edits, deletes and triage are optimistic and roll back
 * with a toast; creating needs the server's id, so the new automation
 * appears when the server answers, at the top of its project.
 */

const FAILURE_KEY = 'errors.automationUpdateFailed';

function missing(kind: string, id: string): ResultAsync<never, DomainError> {
  return errAsync({ type: 'NOT_FOUND', message: `${kind} ${id} is not loaded` });
}

function toastError(messageKey: string, error: DomainError): void {
  clientComposition.platform.effects.emit({
    type: 'toast',
    level: 'error',
    message: i18n.t(messageKey),
    description: error.friendlyMessage ?? i18n.t(`errors.generic.${error.type}`),
  });
}

export function createAutomation(
  request: CreateAutomationRequest,
  layer: DataLayer = getDataLayer(),
): ResultAsync<Automation, DomainError> {
  const data = getAutomationsData(layer);
  return automationsApi
    .createAutomation(request)
    .map((automation) => {
      const top = Math.min(0, ...data.position.values());
      data.position.set(automation.id, top - 1);
      data.upsert([automation]);
      return automation;
    })
    .mapErr((error) => {
      toastError('errors.automationCreateFailed', error);
      return error;
    });
}

export function updateAutomation(
  automationId: string,
  fields: UpdateAutomationRequest,
  layer: DataLayer = getDataLayer(),
): ResultAsync<Automation, DomainError> {
  const data = getAutomationsData(layer);
  if (!data.collection.has(automationId)) return missing('Automation', automationId);
  return optimisticWrite({
    entity: 'automations',
    operation: 'update',
    apply: () =>
      data.collection.update(automationId, (draft) => {
        Object.assign(draft, fields);
      }),
    persist: () => automationsApi.updateAutomation(automationId, fields),
    confirm: (automation) => data.upsert([automation]),
    failureMessageKey: FAILURE_KEY,
  });
}

export function deleteAutomation(
  automationId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getAutomationsData(layer);
  if (!data.collection.has(automationId)) return missing('Automation', automationId);
  return optimisticWrite({
    entity: 'automations',
    operation: 'delete',
    apply: () => data.collection.delete(automationId),
    persist: () => automationsApi.deleteAutomation(automationId),
    confirm: () => data.remove([automationId]),
    failureMessageKey: FAILURE_KEY,
  });
}

/** Start a run now; the run shows up through the realtime run events.
 *  A toast confirms the start once the server accepted it. */
export function triggerAutomation(
  automationId: string,
  name?: string,
): ResultAsync<unknown, DomainError> {
  return automationsApi
    .triggerAutomation(automationId)
    .map((value) => {
      clientComposition.platform.effects.emit({
        type: 'toast',
        level: 'success',
        message: i18n.t('toast.automationTriggered', {
          name: name ?? getAutomationsData(getDataLayer()).collection.get(automationId)?.name ?? '',
        }),
      });
      return value;
    })
    .mapErr((error) => {
      toastError('errors.automationTriggerFailed', error);
      return error;
    });
}

/** Mark an inbox run reviewed or dismissed (or back to pending). */
export function triageRun(
  runId: string,
  triageStatus: RunTriageStatus,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const inbox = getInboxData(layer);
  if (!inbox.collection.has(runId)) return missing('Run', runId);
  return optimisticWrite({
    entity: 'automation-inbox',
    operation: 'triage',
    apply: () =>
      inbox.collection.update(runId, (draft) => {
        draft.run = { ...draft.run, triageStatus };
      }),
    persist: () => automationsApi.triageRun(runId, triageStatus),
    confirm: () => {
      inbox.patch(runId, (row) => ({ ...row, run: { ...row.run, triageStatus } }));
      getRunsData(layer).patch(runId, (run) => ({ ...run, triageStatus }));
    },
    failureMessageKey: FAILURE_KEY,
  });
}

/** Triage several inbox runs at once (the inbox's selection). Each run is
 *  its own optimistic write, so one failure rolls back only that run. */
export function triageRuns(
  runIds: readonly string[],
  triageStatus: RunTriageStatus,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown[], DomainError[]> {
  return ResultAsync.combineWithAllErrors(
    runIds.map((runId) => triageRun(runId, triageStatus, layer)),
  );
}

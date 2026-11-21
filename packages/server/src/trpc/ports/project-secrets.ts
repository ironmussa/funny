/**
 * A project's secrets (openspec project-secrets), for the `projectSecrets`
 * tRPC router. The procedure checked the project capability; the service
 * re-checks it per scope (a shared secret needs `manage`) and scopes personal
 * rows to the caller. No answer carries a value.
 */

import { failure, type ApiFailure, type ProjectSecretsPort } from '@funny/api';

import { log } from '../../lib/logger.js';
import {
  projectSecretsService,
  type ProjectSecretError,
  type ProjectSecretsService,
} from '../../services/project-secrets.js';

const STATUS: Record<Exclude<ProjectSecretError['kind'], 'storage'>, 400 | 403 | 404> = {
  'not-found': 404,
  forbidden: 403,
  invalid: 400,
};

function secretFailure(error: ProjectSecretError): ApiFailure {
  if (error.kind === 'storage') {
    log.error('Project secrets storage failure', {
      namespace: 'project-secrets',
      error: error.message,
    });
    return failure(500, 'Internal error');
  }
  return failure(STATUS[error.kind], error.message);
}

function createProjectSecretsPort(
  secrets: ProjectSecretsService = projectSecretsService(),
): ProjectSecretsPort {
  return {
    async list(userId, projectId) {
      return secrets.list(userId, projectId).mapErr(secretFailure);
    },
    async set(userId, input) {
      return secrets.set(userId, input).mapErr(secretFailure);
    },
    async remove(userId, projectId, id) {
      return secrets
        .remove(userId, projectId, id)
        .map(() => ({ ok: true as const }))
        .mapErr(secretFailure);
    },
  };
}

export const projectSecretsPort = createProjectSecretsPort();

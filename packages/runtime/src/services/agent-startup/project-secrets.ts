/**
 * Project secrets at agent start (openspec `project-secrets`): ask the server
 * for the secrets of the thread's project and turn them into environment
 * variables. Asked at every start and kept in memory for that run only, so a
 * changed or revoked secret applies on the next start and nothing is on disk.
 */
import type { SecretValue } from '@funny/shared/project-secrets';
import { Result, err, ok } from 'neverthrow';

import { log } from '../../lib/logger.js';

/** What the server answers to `data:get_project_secrets`. */
export interface ProjectSecretsReply {
  secrets?: SecretValue[];
  error?: string;
  message?: string;
  secretName?: string;
}

export type FetchProjectSecrets = (threadId: string) => Promise<ProjectSecretsReply | null>;

/**
 * What a server from before this change answers: its operation table has no
 * such operation. Only this refusal means "no secrets"; any other failure
 * stops the start, so an agent never runs with a secret silently missing.
 */
const OLD_SERVER_REFUSAL = 'operation is not allowed';

const defaultFetch: FetchProjectSecrets = async (threadId) => {
  const { remoteGetProjectSecrets } = await import('../remote-project-identity-client.js');
  return remoteGetProjectSecrets(threadId);
};

function isSecretValue(value: unknown): value is SecretValue {
  const candidate = value as SecretValue | null;
  return typeof candidate?.name === 'string' && typeof candidate?.value === 'string';
}

/** The thread's project secrets, or the reason they could not be read. */
export async function loadProjectSecrets(
  threadId: string,
  fetchSecrets: FetchProjectSecrets = defaultFetch,
): Promise<Result<SecretValue[], string>> {
  let reply: ProjectSecretsReply | null;
  try {
    reply = await fetchSecrets(threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === OLD_SERVER_REFUSAL) {
      log.info('Server does not serve project secrets yet; starting without them', {
        namespace: 'project-secrets',
        threadId,
      });
      return ok([]);
    }
    return err(`Could not read the project secrets: ${message}`);
  }
  if (reply?.error) {
    return err(reply.message ?? `Could not read the project secrets (${reply.error})`);
  }
  const secrets = Array.isArray(reply?.secrets) ? reply.secrets.filter(isSecretValue) : [];
  if (secrets.length > 0) {
    log.info('Project secrets loaded for agent start', {
      namespace: 'project-secrets',
      threadId,
      count: secrets.length,
    });
  }
  return ok(secrets);
}

/**
 * The agent's environment, later sources winning: project secrets, then the
 * variables funny computes (`buildAgentEnv`), then the agent execution
 * profile. A project secret overrides what the runner inherited from its shell
 * and never a variable funny set. Undefined when there is nothing to add, so
 * the orchestrator keeps the inherited environment.
 */
export function composeAgentEnv(
  secrets: readonly SecretValue[],
  baseEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (secrets.length === 0) return baseEnv;
  const secretEnv = Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
  return { ...secretEnv, ...baseEnv };
}

/** Applies `redact` (when there is one) to every string inside `value`, keeping its shape. */
export function redactDeep<T>(value: T, redact: ((text: string) => string) | undefined): T {
  if (!redact) return value;
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

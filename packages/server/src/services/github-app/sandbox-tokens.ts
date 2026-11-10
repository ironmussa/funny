/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * The GitHub token a sandbox thread's runner receives (sandbox-github-app-tokens):
 * a GitHub App token for the repository its sandbox cloned, capped by the
 * thread owner's access. Only while the thread exists, is not archived and its
 * sandbox is usable. The data scope already limits the request to the thread's
 * own sandbox runner. Every issuance and refusal is audited, never the token.
 */

import { eq } from 'drizzle-orm';
import { errAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes, threads } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { relayToUser } from '../browser-events.js';
import { getProviderKey } from '../profile-service.js';
import { serverSideProjectGithubToken } from '../runner-scope.js';
import { postSandboxError } from '../thread-sandboxes/sandbox-events.js';
import { loadGithubAppConfig, sqlSettingsStore } from './app-config.js';
import { createGithubAppTokenIssuer, type IssueError, type RepoToken } from './token-issuer.js';

/** Sandbox states whose agents may use GitHub (same as the LLM proxy). */
const USABLE_STATES = new Set(['connecting', 'bootstrapping', 'running']);

/** `owner/name` of a GitHub https or ssh URL, or null for anything else. */
export function githubRepoOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url) ??
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export interface SandboxThreadFacts {
  ownerId: string;
  projectId: string | null;
  repoUrl: string | null;
  usable: boolean;
}

export interface SandboxTokenDeps {
  thread(threadId: string): Promise<SandboxThreadFacts | null>;
  /** The owner's GitHub token for the access check (project override, then their PAT). */
  ownerToken(ownerId: string, projectId: string | null): Promise<string | null>;
  issue(repo: string, ownerToken: string | null): ResultAsync<RepoToken, IssueError>;
  /** Tell the thread why it has no GitHub access (a card the user can act on). */
  notify?(threadId: string, ownerId: string, error: IssueError): void;
}

/** What the user can do about each refusal; transient GitHub errors get no card. */
const GITHUB_ACCESS_HINTS: Partial<Record<IssueError['kind'], string>> = {
  'not-configured':
    'An admin must connect a GitHub App for this funny server in Preferences > GitHub App.',
  'not-installed':
    "Install the GitHub App on this repository's account: Preferences > GitHub App > Install on repositories.",
  'no-access':
    'Your GitHub token (Preferences > GitHub) is missing or has no access to this repository. A sandbox only gets what you can do yourself.',
};

const refused = (kind: IssueError['kind'], message: string): IssueError => ({ kind, message });

export function createSandboxTokenService(deps: SandboxTokenDeps) {
  // The runner asks again every 45 minutes: one card per thread and reason.
  const notified = new Set<string>();
  const tell = (threadId: string, ownerId: string, error: IssueError) => {
    const key = `${threadId}:${error.kind}`;
    if (!GITHUB_ACCESS_HINTS[error.kind] || notified.has(key)) return;
    notified.add(key);
    deps.notify?.(threadId, ownerId, error);
  };
  return {
    issueFor(threadId: string): ResultAsync<RepoToken, IssueError> {
      return ResultAsync.fromPromise(deps.thread(threadId), (error) =>
        refused('github-error', String(error)),
      ).andThen((facts) => {
        const repo = githubRepoOf(facts?.repoUrl);
        if (!facts || !facts.usable || !repo) {
          const error = refused(
            'no-access',
            'This thread has no running sandbox on a GitHub repository',
          );
          audit({
            action: 'github.sandbox_token_refused',
            actorId: facts?.ownerId ?? null,
            detail: error.message,
            meta: { threadId, kind: error.kind },
          });
          return errAsync(error);
        }
        return ResultAsync.fromSafePromise(deps.ownerToken(facts.ownerId, facts.projectId))
          .andThen((ownerToken) => deps.issue(repo, ownerToken))
          .andTee((token) =>
            audit({
              action: 'github.sandbox_token_issued',
              actorId: facts.ownerId,
              detail: `GitHub App token for ${token.repo} (${token.level})`,
              meta: { threadId, repo: token.repo, level: token.level, expiresAt: token.expiresAt },
            }),
          )
          .orTee((error) => {
            audit({
              action: 'github.sandbox_token_refused',
              actorId: facts.ownerId,
              detail: error.message,
              meta: { threadId, repo, kind: error.kind },
            });
            tell(threadId, facts.ownerId, error);
          });
      });
    },
  };
}

let production: ReturnType<typeof createSandboxTokenService> | null = null;

/** The production service: the deployment's App, the DB, and the owner's stored tokens. */
export function sandboxTokenService() {
  production ??= createSandboxTokenService({
    async thread(threadId) {
      const [row] = await db
        .select({
          ownerId: threads.userId,
          projectId: threads.projectId,
          archived: threads.archived,
          repoUrl: threadSandboxes.repoUrl,
          state: threadSandboxes.state,
        })
        .from(threads)
        .innerJoin(threadSandboxes, eq(threadSandboxes.threadId, threads.id))
        .where(eq(threads.id, threadId));
      if (!row) return null;
      return {
        ownerId: row.ownerId,
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        usable: !row.archived && USABLE_STATES.has(row.state),
      };
    },
    async ownerToken(ownerId, projectId) {
      const projectToken = projectId ? await serverSideProjectGithubToken(projectId) : null;
      return projectToken ?? (await getProviderKey(ownerId, 'github'));
    },
    issue: createGithubAppTokenIssuer({
      app: () => loadGithubAppConfig(process.env, sqlSettingsStore),
    }).issue,
    notify(threadId, ownerId, error) {
      void postSandboxError(
        {
          threadId,
          userId: ownerId,
          data: {
            phase: 'github',
            kind: error.kind,
            message: error.message,
            hint: GITHUB_ACCESS_HINTS[error.kind],
          },
        },
        { toUser: relayToUser },
      );
    },
  });
  return production;
}

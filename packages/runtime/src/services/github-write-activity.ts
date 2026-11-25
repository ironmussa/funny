/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityTracker
 *
 * Writes to GitHub a user starts from the review pane (track-user-and-
 * scheduled-actions, design D3): merging a pull request, reverting a file in
 * one, publishing a repository and deleting issues, each recorded as one `github.write`
 * activity once GitHub has answered. The route's own answer is unchanged.
 */
import type { JsonObject } from '@bufbuild/protobuf';
import type { ActivityEffect, ActivityResultRef } from '@funny/shared';

import { isObject, isString } from '../lib/value-guards.js';
import { recordActivity as defaultRecordActivity } from './activity-tracker.js';

export interface GithubWrite {
  userId: string;
  projectId: string;
  title: string;
  input: {
    action: 'pr-merge' | 'pr-revert-file' | 'repo-publish' | 'issue-delete';
    prNumber?: number;
    filePath?: string;
    repo?: string;
  };
  /** What a successful answer changed, read from its JSON body (`{}` when it is not an object). */
  effectsOf: (body: JsonObject) => ActivityEffect[];
  resultRefOf?: (body: JsonObject) => ActivityResultRef | undefined;
}

/** The route's answer as a JSON object; `{}` for any other body. */
async function jsonOf(res: Response): Promise<JsonObject> {
  try {
    const body: unknown = await res.clone().json();
    if (!isObject(body) || Array.isArray(body)) return {};
    // SAFETY: `body` came out of JSON.parse and is a non-array object, so every value is JSON.
    return body as JsonObject;
  } catch {
    return {};
  }
}

/** Runs the route's write, records it, and answers what the route answered. */
export async function recordedGithubWrite(
  write: GithubWrite,
  run: () => Promise<Response>,
  record: typeof defaultRecordActivity = defaultRecordActivity,
): Promise<Response> {
  const spec = {
    kind: 'github.write' as const,
    userId: write.userId,
    projectId: write.projectId,
    title: write.title,
    input: write.input,
    origin: 'user' as const,
  };
  let res: Response;
  try {
    res = await run();
  } catch (error) {
    void record(spec, { ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const body = await jsonOf(res);
  if (res.status >= 400) {
    const error = isString(body.error) ? body.error : `GitHub write failed (${res.status})`;
    void record(spec, { ok: false, error });
  } else {
    void record(spec, {
      ok: true,
      effects: write.effectsOf(body),
      resultRef: write.resultRefOf?.(body),
    });
  }
  return res;
}

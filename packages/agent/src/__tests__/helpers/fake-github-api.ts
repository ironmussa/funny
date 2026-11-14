/**
 * GitHub at the HTTP level, injected as `fetch`: the App endpoints, issues,
 * labels, comments and pull requests the factory uses. It checks credentials
 * like GitHub does: the App endpoints need an App JWT, everything else an
 * installation token that is unexpired (on the fake clock) and limited to the
 * repository. Tests read its state; they never look inside the factory.
 */

import type { FakeClock } from './fake-clock.js';

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  comments: Array<{ author: string; body: string }>;
  createdAt: string;
  state: 'open' | 'closed';
  /** Issues blocking this one (GitHub's native issue dependencies). */
  blockedBy: number[];
}

export interface FakePull {
  number: number;
  url: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  /** The installation token it was opened with. */
  token: string;
  /** The head commit's check runs; tests set them as CI would. */
  checks: FakeCheck[];
  /** `false` when it conflicts with its base; `null` while GitHub computes it. */
  mergeable: boolean | null;
  /** Branch protection: a review is required before merging. */
  requiresReview: boolean;
  approved: boolean;
  /** Auto-merge as enabled through GraphQL. */
  autoMerge: { method: string } | null;
  merged: boolean;
  /** How it was merged. */
  mergedWith: string | null;
  state: 'open' | 'closed';
}

/** The repository's merge settings (`GET /repos/:repo`). */
export interface FakeRepoSettings {
  allow_squash_merge: boolean;
  allow_merge_commit: boolean;
  allow_rebase_merge: boolean;
  allow_auto_merge: boolean;
}

export interface FakeCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped' | 'timed_out' | 'cancelled';
  /** The job's log, served by `GET /actions/jobs/:id/logs`. */
  log?: string;
}

export interface FakeGithubApi {
  readonly api: string;
  readonly fetch: typeof fetch;
  readonly issues: Map<number, FakeIssue>;
  readonly pulls: FakePull[];
  /** Installation tokens minted, oldest first. */
  readonly tokens: Array<{ token: string; repo: string; expiresAt: number; permissions: unknown }>;
  /** Every credential GitHub refused, with the request. */
  readonly refused: Array<{ method: string; path: string; auth: string }>;
  /** Every credential presented, to prove which ones were (not) used. */
  readonly credentialsSeen: Set<string>;
  addIssue(issue: Partial<FakeIssue> & { number: number; author: string }): FakeIssue;
  /** Every request made with an installation token, in order (`POST /repos/…/assignees`). */
  readonly requests: string[];
  readonly repoSettings: FakeRepoSettings;
  /** Whether the Factory App is installed on the repository. */
  installed: boolean;
  /** The repository's labels. */
  readonly labels: Set<string>;
  /** Leave the merge settings out of `GET /repos/:repo`, as GitHub does for some tokens. */
  hideMergeSettings: boolean;
  /** Refuse `PUT /pulls/:n/merge` with 405, as when requirements changed meanwhile. */
  refuseDirectMerge: boolean;
  /** Branches deleted through `DELETE /git/refs/heads/…`. */
  readonly deletedBranches: string[];
  /** Make requests whose method and path end match fail with `status` until `heal`. */
  fail(method: string, pathEnd: string, status?: number): void;
  heal(method: string, pathEnd: string): void;
  /** Never answer requests whose method and path end match (a process that stops waiting on them). */
  hang(method: string, pathEnd: string): void;
  /** Requests left hanging, in order. */
  readonly hung: string[];
}

const BOT = 'funny-factory[bot]';
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export function fakeGithubApi(options: {
  clock: FakeClock;
  repo: string;
  defaultBranch?: string;
}): FakeGithubApi {
  const apiRoot = 'https://api.github.test';
  const issues = new Map<number, FakeIssue>();
  const pulls: FakePull[] = [];
  const tokens: FakeGithubApi['tokens'] = [];
  const refused: FakeGithubApi['refused'] = [];
  const credentialsSeen = new Set<string>();
  const requests: string[] = [];
  const deletedBranches: string[] = [];
  const labels = new Set<string>();
  const repoSettings: FakeRepoSettings = {
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: true,
  };
  const failures = new Map<string, { method: string; pathEnd: string; status: number }>();
  const injectedFailure = (method: string, path: string) =>
    [...failures.values()].find((f) => f.method === method && path.endsWith(f.pathEnd));
  let nextNumber = 1000;

  /** One page of a list, as GitHub pages it (`per_page`, `page`). */
  const page = <T>(url: URL, items: T[]): T[] => {
    const size = Number(url.searchParams.get('per_page') ?? 30);
    const at = Number(url.searchParams.get('page') ?? 1);
    return items.slice((at - 1) * size, at * size);
  };

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  const restIssue = (issue: FakeIssue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: issue.author },
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login })),
    created_at: issue.createdAt,
    state: issue.state,
  });

  type Route = (method: string, url: URL, body: any) => Response | null;

  /** App endpoints: they take the App's JWT. */
  const appRoutes = (method: string, path: string, body: any): Response | null => {
    if (path === `/repos/${options.repo}/installation` && method === 'GET') {
      return api.installed ? json(200, { id: 7 }) : json(404, { message: 'Not Found' });
    }
    if (path === '/app/installations/7/access_tokens' && method === 'POST') {
      const token = `ghs_installation_${tokens.length + 1}`;
      const expiresAt = options.clock.now().getTime() + TOKEN_LIFETIME_MS;
      tokens.push({ token, repo: options.repo, expiresAt, permissions: body?.permissions });
      return json(201, { token, expires_at: new Date(expiresAt).toISOString() });
    }
    return null;
  };

  const repoRoutes: Route = (method, url, body) => {
    const rest = url.pathname.slice(`/repos/${options.repo}`.length);
    if (rest === '' && method === 'GET') {
      return json(200, {
        full_name: options.repo,
        default_branch: options.defaultBranch ?? 'main',
        ...(api.hideMergeSettings ? {} : repoSettings),
      });
    }
    if (rest === '/issues' && method === 'GET') {
      const label = url.searchParams.get('labels');
      const listed = [...issues.values()]
        .filter((i) => i.state === 'open' && (!label || i.labels.includes(label)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return json(200, page(url, listed).map(restIssue));
    }
    if (rest === '/pulls') return pullsRoute(method, url, body);
    return rest.startsWith('/labels') ? labelsRoute(method, rest, body) : null;
  };

  /** The repository's labels: `GET /labels/:name`, `POST /labels`. */
  const labelsRoute = (method: string, rest: string, body: any): Response | null => {
    if (method === 'POST' && rest === '/labels') {
      labels.add(body.name);
      return json(201, { name: body.name });
    }
    const name = decodeURIComponent(rest.slice('/labels/'.length));
    if (method !== 'GET' || !name) return null;
    return labels.has(name) ? json(200, { name }) : json(404, { message: 'Not Found' });
  };

  /** `POST /pulls` opens one; `GET /pulls?head=owner:branch` lists the open ones. */
  const pullsRoute: Route = (method, url, body) => {
    if (method === 'POST') return openPull(body);
    const head = url.searchParams.get('head')?.split(':')[1];
    const open = pulls.filter((p) => p.state === 'open' && (!head || p.head === head));
    return json(
      200,
      open.map((p) => ({ number: p.number, html_url: p.url })),
    );
  };

  let presented = '';
  const openPull = (body: any) => {
    const number = nextNumber++;
    const pull: FakePull = {
      number,
      url: `https://github.com/${options.repo}/pull/${number}`,
      title: body.title,
      body: body.body,
      head: body.head,
      base: body.base,
      draft: body.draft === true,
      token: presented,
      checks: [],
      mergeable: true,
      requiresReview: false,
      approved: false,
      autoMerge: null,
      merged: false,
      mergedWith: null,
      state: 'open',
    };
    pulls.push(pull);
    return json(201, { number, html_url: pull.url, draft: pull.draft });
  };

  /** Check run ids are the pull request number and the check's index. */
  const checkId = (pull: FakePull, index: number) => pull.number * 100 + index;

  const pullByNumber = (n: string | number) => pulls.find((p) => p.number === Number(n));

  /** Branch protections as GitHub applies them: green checks, no conflict, a review if required. */
  const requirementsMet = (pull: FakePull) =>
    !pull.draft &&
    pull.mergeable !== false &&
    pull.checks.every(
      (c) =>
        c.status === 'completed' && ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''),
    ) &&
    (!pull.requiresReview || pull.approved);

  const merge = (pull: FakePull, method: string) => {
    pull.merged = true;
    pull.mergedWith = method;
    pull.state = 'closed';
  };

  const pullRoute = (rest: string): Response | null => {
    const pull = pullByNumber(/^\/pulls\/(\d+)$/.exec(rest)?.[1] ?? NaN);
    if (!pull) return null;
    // GitHub merges an auto-merge pull request once its requirements are met.
    if (pull.autoMerge && !pull.merged && requirementsMet(pull)) merge(pull, pull.autoMerge.method);
    return json(200, {
      number: pull.number,
      node_id: `PR_${pull.number}`,
      state: pull.state,
      merged: pull.merged,
      auto_merge: pull.autoMerge ? { merge_method: pull.autoMerge.method } : null,
      draft: pull.draft,
      mergeable: pull.mergeable,
      mergeable_state: pull.mergeable === false ? 'dirty' : 'clean',
      head: { sha: `sha-${pull.number}`, ref: pull.head },
    });
  };

  const commitRoute = (rest: string): Response | null => {
    const match = /^\/commits\/sha-(\d+)\/(check-runs|status)$/.exec(rest);
    const pull = match ? pullByNumber(match[1]) : undefined;
    if (!match || !pull) return null;
    if (match[2] === 'status') return json(200, { state: 'success', statuses: [] });
    return json(200, {
      check_runs: pull.checks.map((c, i) => ({
        id: checkId(pull, i),
        name: c.name,
        status: c.status,
        conclusion: c.conclusion ?? null,
        app: { slug: 'github-actions' },
        output: { title: c.name, summary: `${c.name} ${c.conclusion ?? c.status}` },
      })),
    });
  };

  const logRoute = (rest: string): Response | null => {
    const id = Number(/^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)?.[1] ?? NaN);
    const check = pullByNumber(Math.floor(id / 100))?.checks[id % 100];
    return check ? new Response(check.log ?? '', { status: 200 }) : null;
  };

  const ciRoutes: Route = (method, url) => {
    if (method !== 'GET') return null;
    const rest = url.pathname.slice(`/repos/${options.repo}`.length);
    return pullRoute(rest) ?? commitRoute(rest) ?? logRoute(rest);
  };

  const gqlError = (message: string) => json(200, { errors: [{ message }] });

  /** `enablePullRequestAutoMerge`, refused the way GitHub refuses it. */
  const enableAutoMerge = (pull: FakePull, method: string): Response => {
    if (pull.draft) return gqlError('Pull request is in draft state');
    if (!repoSettings.allow_auto_merge)
      return gqlError('Auto merge is not allowed for this repository');
    if (!methodAllowed(method)) {
      return gqlError(`Merge method ${method.toLowerCase()} is not allowed on this repository`);
    }
    if (requirementsMet(pull)) return gqlError('Pull request is in clean status');
    pull.autoMerge = { method: method.toLowerCase() };
    return json(200, {
      data: { enablePullRequestAutoMerge: { pullRequest: { number: pull.number } } },
    });
  };

  /** GraphQL: `markPullRequestReadyForReview` and `enablePullRequestAutoMerge`. */
  const graphql = (body: any): Response => {
    const pull = pulls.find((p) => `PR_${p.number}` === body?.variables?.id);
    const query: string = body?.query ?? '';
    if (!pull) return gqlError('Could not resolve to a node');
    if (/enablePullRequestAutoMerge/.test(query))
      return enableAutoMerge(pull, body.variables.method);
    if (!/markPullRequestReadyForReview/.test(query)) return gqlError('Unknown mutation');
    pull.draft = false;
    return json(200, {
      data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
    });
  };

  const methodAllowed = (method: string) => {
    const setting = {
      squash: 'allow_squash_merge',
      merge: 'allow_merge_commit',
      rebase: 'allow_rebase_merge',
    }[method.toLowerCase()] as keyof FakeRepoSettings;
    return repoSettings[setting];
  };

  /** `PUT /pulls/:n/merge`: merged only when the branch protections are met. */
  const mergePullRoute = (rest: string, body: any): Response | null => {
    const pull = pullByNumber(/^\/pulls\/(\d+)\/merge$/.exec(rest)?.[1] ?? NaN);
    if (!pull) return null;
    if (api.refuseDirectMerge || !requirementsMet(pull)) {
      return json(405, { message: 'Pull Request is not mergeable' });
    }
    merge(pull, body?.merge_method ?? 'merge');
    return json(200, { merged: true });
  };

  /** `DELETE /git/refs/heads/…`. */
  const deleteRefRoute = (rest: string): Response | null => {
    const ref = /^\/git\/refs\/heads\/(.+)$/.exec(rest)?.[1];
    if (!ref) return null;
    deletedBranches.push(decodeURIComponent(ref));
    return new Response(null, { status: 204 });
  };

  const mergeRoutes: Route = (method, url, body) => {
    const rest = url.pathname.slice(`/repos/${options.repo}`.length);
    if (method === 'PUT') return mergePullRoute(rest, body);
    return method === 'DELETE' ? deleteRefRoute(rest) : null;
  };

  const addAll = (list: string[], added: string[]) => {
    for (const item of added) if (!list.includes(item)) list.push(item);
  };

  const removeLabel = (issue: FakeIssue, sub: string) => {
    const name = decodeURIComponent(sub.slice('/labels/'.length));
    if (!issue.labels.includes(name)) return json(404, { message: 'Label does not exist' });
    issue.labels = issue.labels.filter((l) => l !== name);
    return json(200, []);
  };

  const issueHandlers: Record<string, (issue: FakeIssue, body: any, sub: string) => Response> = {
    'GET ': (issue) => json(200, restIssue(issue)),
    'GET /comments': (issue) =>
      json(
        200,
        issue.comments.map((c) => ({ user: { login: c.author }, body: c.body })),
      ),
    'POST /comments': (issue, body) => {
      issue.comments.push({ author: BOT, body: body.body });
      return json(201, {});
    },
    'POST /assignees': (issue, body) => {
      addAll(issue.assignees, body.assignees);
      return json(201, restIssue(issue));
    },
    'POST /labels': (issue, body) => {
      addAll(issue.labels, body.labels);
      return json(200, []);
    },
    'DELETE /labels/:name': (issue, _body, sub) => removeLabel(issue, sub),
    'GET /dependencies/blocked_by': (issue) =>
      json(
        200,
        issue.blockedBy.flatMap((n) => {
          const blocker = issues.get(n);
          return blocker ? [{ number: n, state: blocker.state }] : [];
        }),
      ),
  };

  const issueRoutes: Route = (method, url, body) => {
    const match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/[^?]*)?$/.exec(url.pathname);
    const issue = match ? issues.get(Number(match[1])) : undefined;
    if (!match || !issue) return null;
    const sub = match[2] ?? '';
    const handler = issueHandlers[`${method} ${sub.replace(/^\/labels\/.+$/, '/labels/:name')}`];
    return handler ? handler(issue, body, sub) : null;
  };

  const isJwt = (credential: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential);
  const validToken = (credential: string) =>
    tokens.some((t) => t.token === credential && t.expiresAt > options.clock.now().getTime());
  const repoScoped = [repoRoutes, ciRoutes, mergeRoutes, issueRoutes];

  /** Routes with an installation token: GraphQL and the repository's REST API. */
  function withToken(method: string, url: URL, body: any): Response {
    if (url.pathname === '/graphql' && method === 'POST') return graphql(body);
    for (const route of repoScoped) {
      const answer = route(method, url, body);
      if (answer) return answer;
    }
    return json(404, { message: 'Not Found' });
  }

  function handle(method: string, url: URL, auth: string, body: any): Response {
    const credential = auth.replace(/^(Bearer|token) /, '');
    credentialsSeen.add(credential);
    const deny = () => {
      refused.push({ method, path: url.pathname, auth: credential });
      return json(401, { message: 'Bad credentials' });
    };
    const app = appRoutes(method, url.pathname, body);
    if (app) return isJwt(credential) ? app : deny();
    const inScope =
      url.pathname === '/graphql' || url.pathname.startsWith(`/repos/${options.repo}`);
    if (!inScope) return json(404, { message: 'Not Found' });
    if (!validToken(credential)) return deny();
    presented = credential;
    requests.push(`${method} ${url.pathname}`);
    const failure = injectedFailure(method, url.pathname);
    if (failure) return json(failure.status, { message: 'Server Error' });
    return withToken(method, url, body);
  }

  const hangs: Array<{ method: string; pathEnd: string }> = [];
  const hung: string[] = [];
  const fetchFake = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? 'GET';
    if (hangs.some((x) => x.method === method && url.pathname.endsWith(x.pathEnd))) {
      hung.push(`${method} ${url.pathname}`);
      return new Promise<Response>(() => {});
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return handle(init.method ?? 'GET', url, headers.authorization ?? '', body);
  }) as unknown as typeof fetch;

  const api: FakeGithubApi = {
    installed: true,
    labels,
    hideMergeSettings: false,
    refuseDirectMerge: false,
    api: apiRoot,
    fetch: fetchFake,
    issues,
    pulls,
    tokens,
    refused,
    credentialsSeen,
    requests,
    repoSettings,
    deletedBranches,
    fail(method, pathEnd, status = 502) {
      failures.set(`${method} ${pathEnd}`, { method, pathEnd, status });
    },
    heal(method, pathEnd) {
      failures.delete(`${method} ${pathEnd}`);
      const at = hangs.findIndex((x) => x.method === method && x.pathEnd === pathEnd);
      if (at >= 0) hangs.splice(at, 1);
    },
    hung,
    hang(method, pathEnd) {
      hangs.push({ method, pathEnd });
    },
    addIssue(partial) {
      const issue: FakeIssue = {
        title: `Issue ${partial.number}`,
        body: '',
        labels: [],
        assignees: [],
        comments: [],
        blockedBy: [],
        createdAt: new Date(
          Date.parse('2026-11-01T00:00:00Z') + partial.number * 1000,
        ).toISOString(),
        state: 'open',
        ...partial,
      };
      issues.set(issue.number, issue);
      return issue;
    },
  };
  return api;
}

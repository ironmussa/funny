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
}

const BOT = 'funny-factory[bot]';
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export function fakeGithubApi(options: {
  clock: FakeClock;
  repo: string;
  defaultBranch?: string;
}): FakeGithubApi {
  const api = 'https://api.github.test';
  const issues = new Map<number, FakeIssue>();
  const pulls: FakePull[] = [];
  const tokens: FakeGithubApi['tokens'] = [];
  const refused: FakeGithubApi['refused'] = [];
  const credentialsSeen = new Set<string>();
  let nextNumber = 1000;

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
    if (path === `/repos/${options.repo}/installation` && method === 'GET')
      return json(200, { id: 7 });
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
      });
    }
    if (rest === '/issues' && method === 'GET') {
      const label = url.searchParams.get('labels');
      const listed = [...issues.values()]
        .filter((i) => i.state === 'open' && (!label || i.labels.includes(label)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return json(200, listed.map(restIssue));
    }
    if (rest === '/pulls' && method === 'POST') return openPull(body);
    return null;
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
    };
    pulls.push(pull);
    return json(201, { number, html_url: pull.url, draft: pull.draft });
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
  };

  const issueRoutes: Route = (method, url, body) => {
    const match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/[^?]*)?$/.exec(url.pathname);
    const issue = match ? issues.get(Number(match[1])) : undefined;
    if (!match || !issue) return null;
    const sub = match[2] ?? '';
    const handler = issueHandlers[`${method} ${sub.replace(/^\/labels\/.+$/, '/labels/:name')}`];
    return handler ? handler(issue, body, sub) : null;
  };

  function handle(method: string, url: URL, auth: string, body: any): Response {
    const credential = auth.replace(/^(Bearer|token) /, '');
    credentialsSeen.add(credential);
    const deny = () => {
      refused.push({ method, path: url.pathname, auth: credential });
      return json(401, { message: 'Bad credentials' });
    };
    const notFound = () => json(404, { message: 'Not Found' });
    const isJwt = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential);
    const app = appRoutes(method, url.pathname, body);
    if (app) return isJwt ? app : deny();
    if (!url.pathname.startsWith(`/repos/${options.repo}`)) return notFound();
    const now = options.clock.now().getTime();
    if (!tokens.some((t) => t.token === credential && t.expiresAt > now)) return deny();
    presented = credential;
    return repoRoutes(method, url, body) ?? issueRoutes(method, url, body) ?? notFound();
  }

  const fetchFake = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return handle(init.method ?? 'GET', url, headers.authorization ?? '', body);
  }) as unknown as typeof fetch;

  return {
    api,
    fetch: fetchFake,
    issues,
    pulls,
    tokens,
    refused,
    credentialsSeen,
    addIssue(partial) {
      const issue: FakeIssue = {
        title: `Issue ${partial.number}`,
        body: '',
        labels: [],
        assignees: [],
        comments: [],
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
}

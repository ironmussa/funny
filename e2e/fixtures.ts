import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  mode: 'local' | 'worktree';
  status: string;
  stage: string;
  provider: string;
  model: string;
  branch?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  API helper class                                                   */
/* ------------------------------------------------------------------ */

export class ApiHelper {
  constructor(
    private request: APIRequestContext,
    private baseURL: string,
    private token: string,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async createProject(name: string, repoPath: string): Promise<Project> {
    const res = await this.request.post(`${this.baseURL}/api/projects`, {
      headers: this.headers(),
      data: { name, path: repoPath },
    });
    expect(res.ok(), `createProject failed: ${res.status()}`).toBeTruthy();
    return res.json();
  }

  async deleteProject(id: string): Promise<void> {
    await this.request.delete(`${this.baseURL}/api/projects/${id}`, {
      headers: this.headers(),
    });
  }

  async getProjects(): Promise<Project[]> {
    const res = await this.request.get(`${this.baseURL}/api/projects`, {
      headers: this.headers(),
    });
    return res.json();
  }

  async createIdleThread(
    projectId: string,
    title: string,
    opts?: { prompt?: string; mode?: 'local' | 'worktree'; stage?: string },
  ): Promise<Thread> {
    const res = await this.request.post(`${this.baseURL}/api/threads/idle`, {
      headers: this.headers(),
      data: {
        projectId,
        title,
        mode: opts?.mode ?? 'local',
        prompt: opts?.prompt ?? '',
        stage: opts?.stage ?? 'backlog',
      },
    });
    expect(res.ok(), `createIdleThread failed: ${res.status()}`).toBeTruthy();
    return res.json();
  }

  async deleteThread(id: string): Promise<void> {
    await this.request.delete(`${this.baseURL}/api/threads/${id}`, {
      headers: this.headers(),
    });
  }

  async archiveThread(id: string): Promise<void> {
    await this.request.patch(`${this.baseURL}/api/threads/${id}`, {
      headers: this.headers(),
      data: { archived: true },
    });
  }

  async pinThread(id: string, pinned: boolean): Promise<void> {
    await this.request.patch(`${this.baseURL}/api/threads/${id}`, {
      headers: this.headers(),
      data: { pinned },
    });
  }

  async updateThreadStage(id: string, stage: string): Promise<void> {
    await this.request.patch(`${this.baseURL}/api/threads/${id}`, {
      headers: this.headers(),
      data: { stage },
    });
  }

  async getThreads(projectId?: string): Promise<Thread[]> {
    const url = projectId
      ? `${this.baseURL}/api/threads?projectId=${projectId}`
      : `${this.baseURL}/api/threads`;
    const res = await this.request.get(url, { headers: this.headers() });
    return res.json();
  }

  async getBranches(
    projectId: string,
  ): Promise<{ branches: string[]; defaultBranch: string | null }> {
    const res = await this.request.get(`${this.baseURL}/api/projects/${projectId}/branches`, {
      headers: this.headers(),
    });
    return res.json();
  }
}

/* ------------------------------------------------------------------ */
/*  Temp git repo helper                                               */
/* ------------------------------------------------------------------ */

export function createTempGitRepo(suffix = ''): string {
  const tmpBase = process.env.TEMP || process.env.TMP || 'C:\\Temp';
  const dir = path.join(tmpBase, `funny-e2e-${Date.now()}${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  // Create an initial commit so branches work
  const readmePath = path.join(dir, 'README.md');
  fs.writeFileSync(readmePath, '# Test Repo\n');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows (file locks)
  }
}

/* ------------------------------------------------------------------ */
/*  Bootstrap helper                                                   */
/* ------------------------------------------------------------------ */

async function fetchBootstrapToken(request: APIRequestContext, baseURL: string): Promise<string> {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await request.get(`${baseURL}/api/bootstrap`);
    if (res.status() === 429) {
      // Rate limited — wait with exponential backoff then retry
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    expect(res.ok(), `bootstrap failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.mode).toBe('local');
    return body.token;
  }
  throw new Error('fetchBootstrapToken: exhausted retries (429 rate limit)');
}

/* ------------------------------------------------------------------ */
/*  Custom fixtures                                                    */
/* ------------------------------------------------------------------ */

type Fixtures = {
  /** Auth token for API calls */
  authToken: string;
  /** API helper with auth preconfigured */
  api: ApiHelper;
  /** Page already authenticated (token injected via localStorage/cookie) */
  authedPage: Page;
  /** Create a temp git repo, auto-cleaned up after test */
  tempRepo: string;
};

export const test = base.extend<Fixtures>({
  authToken: async ({ request, baseURL }, use) => {
    const token = await fetchBootstrapToken(request, baseURL!);
    await use(token);
  },

  api: async ({ request, baseURL, authToken }, use) => {
    const helper = new ApiHelper(request, baseURL!, authToken);
    await use(helper);
  },

  authedPage: async ({ page, baseURL: _baseURL, authToken: _authToken }, use) => {
    // Navigate to app — the app fetches /api/bootstrap on its own
    // We just need to wait for it to finish loading
    await page.goto('/');
    // Wait for the app shell to be ready (sidebar should appear)
    await page.waitForLoadState('networkidle');
    await use(page);
  },

  // eslint-disable-next-line no-empty-pattern
  tempRepo: async ({}, use) => {
    const dir = createTempGitRepo();
    await use(dir);
    removeTempDir(dir);
  },
});

export { expect };

/* ------------------------------------------------------------------ */
/*  Common helpers for page interactions                               */
/* ------------------------------------------------------------------ */

/** Wait for sidebar to fully load */
export async function waitForSidebar(page: Page) {
  // Wait for either a project item or the "no projects" CTA
  await page
    .locator('[data-testid="sidebar-settings"]')
    .waitFor({ state: 'visible', timeout: 10000 });
}

/** Create a project via API and return it, navigating the page to it */
export async function seedProject(
  api: ApiHelper,
  page: Page,
  repoPath: string,
  name = 'Test Project',
) {
  const project = await api.createProject(name, repoPath);
  await page.reload();
  await waitForSidebar(page);
  return project;
}

/** Click a sidebar navigation icon */
export async function clickSidebarNav(page: Page, testId: string) {
  // Icons are visible on hover of the header area
  const btn = page.getByTestId(testId);
  await btn.click();
}

/** Open the "new thread" dialog for a project */
export async function openNewThreadDialog(page: Page, projectId: string) {
  await page.getByTestId(`project-new-thread-${projectId}`).click();
}

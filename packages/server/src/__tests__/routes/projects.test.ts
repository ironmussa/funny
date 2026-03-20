/**
 * Integration tests for project routes.
 *
 * Tests the full HTTP request → route → service → DB → response stack
 * against an in-memory SQLite database with real route handlers.
 */

import { mock } from 'bun:test';

// Mock git operations before any service imports
mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedTeamProject, seedProjectMember } from '../helpers/test-db.js';

describe('Project Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
  });

  // ── GET /api/projects ──────────────────────────────────

  describe('GET /api/projects', () => {
    test('returns empty array for a user with no projects', async () => {
      const res = await t.requestAs('user-1').get('/api/projects');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    test('returns only projects owned by the requesting user', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'User1 Project', userId: 'user-1', path: '/a' });
      seedProject(t.db as any, { id: 'p2', name: 'User2 Project', userId: 'user-2', path: '/b' });

      const res = await t.requestAs('user-1').get('/api/projects');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('User1 Project');
    });

    test('excludes org-linked projects from personal listing', async () => {
      seedProject(t.db as any, {
        id: 'p-personal',
        name: 'Personal',
        userId: 'user-1',
        path: '/a',
      });
      seedProject(t.db as any, {
        id: 'p-org',
        name: 'Org Project',
        userId: 'user-1',
        path: '/b',
      });
      seedTeamProject(t.db as any, { teamId: 'org-1', projectId: 'p-org' });

      const res = await t.requestAs('user-1').get('/api/projects');
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('p-personal');
    });

    test('user sees all their projects', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', name: 'P1', path: '/a' });
      seedProject(t.db as any, { id: 'p2', userId: 'user-1', name: 'P2', path: '/b' });

      const res = await t.requestAs('user-1').get('/api/projects');
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  // ── POST /api/projects ─────────────────────────────────

  describe('POST /api/projects', () => {
    test('creates a project with valid name and path (201)', async () => {
      const res = await t.requestAs('user-1').post('/api/projects', {
        name: 'New Project',
        path: '/tmp/test-repo',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Project');
      expect(body.path).toBe('/tmp/test-repo');
      expect(body.userId).toBe('user-1');
      expect(body.id).toBeTruthy();
    });

    test('returns 400 when name is missing', async () => {
      const res = await t.requestAs('user-1').post('/api/projects', {
        path: '/tmp/test-repo',
      });
      expect(res.status).toBe(400);
    });

    test('returns 400 when path is missing', async () => {
      const res = await t.requestAs('user-1').post('/api/projects', {
        name: 'No Path',
      });
      expect(res.status).toBe(400);
    });

    test('returns 409 when project name already exists for user', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Existing', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/projects', {
        name: 'Existing',
        path: '/tmp/other-repo',
      });
      expect(res.status).toBe(409);
    });

    test('allows same name for different users', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Shared Name', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-2').post('/api/projects', {
        name: 'Shared Name',
        path: '/tmp/repo',
      });
      expect(res.status).toBe(201);
    });
  });

  // ── PATCH /api/projects/:id ────────────────────────────

  describe('PATCH /api/projects/:id', () => {
    test('updates project name', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Old Name', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').patch('/api/projects/p1', {
        name: 'New Name',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('New Name');
    });

    test('returns 404 for non-existent project', async () => {
      const res = await t.requestAs('user-1').patch('/api/projects/nonexistent', {
        name: 'X',
      });
      expect(res.status).toBe(404);
    });

    test('returns 403 when non-owner tries to update', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Owned', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-2').patch('/api/projects/p1', {
        name: 'Hijacked',
      });
      expect(res.status).toBe(403);
    });

    test('owner can update their project', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Any', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').patch('/api/projects/p1', {
        name: 'Updated',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated');
    });
  });

  // ── DELETE /api/projects/:id ───────────────────────────

  describe('DELETE /api/projects/:id', () => {
    test('deletes project and returns ok', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'To Delete', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').delete('/api/projects/p1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify project is gone
      const listRes = await t.requestAs('user-1').get('/api/projects');
      const list = await listRes.json();
      expect(list).toHaveLength(0);
    });

    test('returns 404 for non-existent project', async () => {
      const res = await t.requestAs('user-1').delete('/api/projects/nonexistent');
      expect(res.status).toBe(404);
    });

    test('returns 403 when non-owner tries to delete', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Owned', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-2').delete('/api/projects/p1');
      expect(res.status).toBe(403);
    });
  });

  // ── PUT /api/projects/reorder ──────────────────────────

  describe('PUT /api/projects/reorder', () => {
    test('updates sortOrder for specified projects', async () => {
      seedProject(t.db as any, {
        id: 'p1',
        name: 'A',
        sortOrder: 0,
        userId: 'user-1',
        path: '/a',
      });
      seedProject(t.db as any, {
        id: 'p2',
        name: 'B',
        sortOrder: 1,
        userId: 'user-1',
        path: '/b',
      });
      seedProject(t.db as any, {
        id: 'p3',
        name: 'C',
        sortOrder: 2,
        userId: 'user-1',
        path: '/c',
      });

      // Reverse order: C, B, A
      const res = await t.requestAs('user-1').put('/api/projects/reorder', {
        projectIds: ['p3', 'p2', 'p1'],
      });
      expect(res.status).toBe(200);

      // Verify order
      const listRes = await t.requestAs('user-1').get('/api/projects');
      const list = await listRes.json();
      expect(list[0].name).toBe('C');
      expect(list[1].name).toBe('B');
      expect(list[2].name).toBe('A');
    });

    test('returns 400 when projectIds is empty', async () => {
      const res = await t.requestAs('user-1').put('/api/projects/reorder', {
        projectIds: [],
      });
      expect(res.status).toBe(400);
    });

    test('returns 400 when projectIds is missing', async () => {
      const res = await t.requestAs('user-1').put('/api/projects/reorder', {});
      expect(res.status).toBe(400);
    });
  });

  // ── Membership routes ──────────────────────────────────

  describe('Membership routes', () => {
    test('GET /:id/members lists project members', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-1', role: 'admin' });

      const res = await t.requestAs('user-1').get('/api/projects/p1/members');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.members).toHaveLength(1);
      expect(body.members[0].role).toBe('admin');
    });

    test('POST /:id/members adds a member (admin only)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-1', role: 'admin' });

      const res = await t.requestAs('user-1').post('/api/projects/p1/members', {
        userId: 'user-2',
        role: 'member',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.userId).toBe('user-2');
    });

    test('POST /:id/members returns 403 for non-admin', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-2', role: 'member' });

      const res = await t.requestAs('user-2').post('/api/projects/p1/members', {
        userId: 'user-3',
      });
      expect(res.status).toBe(403);
    });

    test('DELETE /:id/members/:userId removes a member', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-1', role: 'admin' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-2', role: 'member' });

      const res = await t.requestAs('user-1').delete('/api/projects/p1/members/user-2');
      expect(res.status).toBe(200);

      // Verify member was removed
      const listRes = await t.requestAs('user-1').get('/api/projects/p1/members');
      const body = await listRes.json();
      expect(body.members).toHaveLength(1);
    });
  });

  // ── GET /api/projects/resolve ──────────────────────────

  describe('GET /api/projects/resolve', () => {
    test('returns 400 when url param is missing', async () => {
      const res = await t.requestAs('user-1').get('/api/projects/resolve');
      expect(res.status).toBe(400);
    });

    test('returns null when no project matches the URL', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t
        .requestAs('user-1')
        .get('/api/projects/resolve?url=https://unknown.com/page');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).toBeNull();
      expect(body.source).toBe('none');
    });

    test('matches project by URL pattern', async () => {
      // Create project with urls via PATCH (urls is string[] — repository stringifies it)
      seedProject(t.db as any, { id: 'p1', name: 'My App', userId: 'user-1', path: '/a' });
      await t.requestAs('user-1').patch('/api/projects/p1', {
        urls: ['https://app.example.com', 'https://api.example.com'],
      });

      const res = await t
        .requestAs('user-1')
        .get('/api/projects/resolve?url=https://app.example.com/dashboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project).not.toBeNull();
      expect(body.project.name).toBe('My App');
      expect(body.source).toBe('url_match');
    });

    test('does not match other users projects', async () => {
      seedProject(t.db as any, { id: 'p1', name: 'Their App', userId: 'user-2', path: '/a' });
      await t.requestAs('user-2').patch('/api/projects/p1', {
        urls: ['https://private.example.com'],
      });

      const res = await t
        .requestAs('user-1')
        .get('/api/projects/resolve?url=https://private.example.com/page');
      const body = await res.json();
      expect(body.project).toBeNull();
    });
  });

  // ── Project settings persistence ───────────────────────

  describe('Project settings persistence', () => {
    test('followUpMode is persisted and returned', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      // Use 'interrupt' — 'queue' is the default and gets omitted by toProject()
      await t.requestAs('user-1').patch('/api/projects/p1', {
        followUpMode: 'interrupt',
      });

      const listRes = await t.requestAs('user-1').get('/api/projects');
      const projects = await listRes.json();
      const project = projects.find((p: any) => p.id === 'p1');
      expect(project.followUpMode).toBe('interrupt');
    });

    test('defaultProvider and defaultModel are persisted', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      await t.requestAs('user-1').patch('/api/projects/p1', {
        defaultProvider: 'claude',
        defaultModel: 'opus',
      });

      const listRes = await t.requestAs('user-1').get('/api/projects');
      const projects = await listRes.json();
      const project = projects.find((p: any) => p.id === 'p1');
      expect(project.defaultProvider).toBe('claude');
      expect(project.defaultModel).toBe('opus');
    });

    test('systemPrompt is persisted', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      await t.requestAs('user-1').patch('/api/projects/p1', {
        systemPrompt: 'You are a helpful coding assistant',
      });

      const listRes = await t.requestAs('user-1').get('/api/projects');
      const projects = await listRes.json();
      const project = projects.find((p: any) => p.id === 'p1');
      expect(project.systemPrompt).toBe('You are a helpful coding assistant');
    });

    test('urls field is persisted as JSON array', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const urls = ['https://app.example.com', 'https://api.example.com'];
      await t.requestAs('user-1').patch('/api/projects/p1', { urls });

      const listRes = await t.requestAs('user-1').get('/api/projects');
      const projects = await listRes.json();
      const project = projects.find((p: any) => p.id === 'p1');
      expect(project.urls).toEqual(urls);
    });

    test('defaultPermissionMode is persisted', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      await t.requestAs('user-1').patch('/api/projects/p1', {
        defaultPermissionMode: 'plan',
      });

      const listRes = await t.requestAs('user-1').get('/api/projects');
      const projects = await listRes.json();
      const project = projects.find((p: any) => p.id === 'p1');
      expect(project.defaultPermissionMode).toBe('plan');
    });
  });
});

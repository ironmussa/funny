/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

/**
 * GitHub OAuth (Device Flow) + repo listing + PR + Actions routes.
 * Mounted at /api/github. Split by verb — see ./github/*.ts.
 */

import { Hono } from 'hono';

import type { HonoEnv } from '../types/hono-env.js';
import { actionRoutes } from './github/actions.js';
import { authRoutes } from './github/auth.js';
import { issueDeleteRoutes } from './github/issue-delete.js';
import { issueRoutes } from './github/issues.js';
import { prFileRoutes } from './github/pr-files.js';
import { prThreadRoutes } from './github/pr-threads.js';
import { prRoutes } from './github/prs.js';
import { repoRoutes } from './github/repos.js';

export const githubRoutes = new Hono<HonoEnv>();

githubRoutes.route('/', authRoutes);
githubRoutes.route('/', repoRoutes);
githubRoutes.route('/', issueRoutes);
githubRoutes.route('/', issueDeleteRoutes);
githubRoutes.route('/', prRoutes);
githubRoutes.route('/', prThreadRoutes);
githubRoutes.route('/', prFileRoutes);
githubRoutes.route('/', actionRoutes);

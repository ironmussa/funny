/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProjectHooksService, StartupCommandsService, CommandRunner
 *
 * Runner-only project routes — filesystem, git, and process operations.
 * Project CRUD (list, create, update, delete, reorder, resolve) is handled
 * by the server package directly.
 *
 * The route logic is split by concern under projects/:
 *   - git-routes: branches + checkout-preflight + checkout
 *   - commands-routes: startup commands CRUD + run + sync-{processes,config}
 *   - config-routes: .funny.json read/write
 *   - hooks-routes: husky-backed project hooks CRUD
 *   - weave-routes: semantic-merge driver status / configure
 */

import { Hono } from 'hono';

import type { HonoEnv } from '../types/hono-env.js';
import { projectCommandsRoutes } from './projects/commands-routes.js';
import { projectConfigRoutes } from './projects/config-routes.js';
import { projectGitRoutes } from './projects/git-routes.js';
import { projectHooksRoutes } from './projects/hooks-routes.js';
import { projectWeaveRoutes } from './projects/weave-routes.js';

export const projectRoutes = new Hono<HonoEnv>();

projectRoutes.route('/', projectGitRoutes);
projectRoutes.route('/', projectCommandsRoutes);
projectRoutes.route('/', projectConfigRoutes);
projectRoutes.route('/', projectHooksRoutes);
projectRoutes.route('/', projectWeaveRoutes);

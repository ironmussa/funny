/**
 * Typed fixtures for the service tests (`__tests__/services/**`), on top of the
 * shared builders in `builders.ts`.
 */

import type { PermissionRule } from '../../services/permission-rules-client.js';

export function buildPermissionRule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: 'rule-1',
    userId: 'u-1',
    projectPath: '/repo',
    toolName: 'Bash',
    pattern: null,
    decision: 'allow',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

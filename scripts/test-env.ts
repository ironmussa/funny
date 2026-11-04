/**
 * Environment for running package test suites.
 *
 * Git exports repository-locating variables to the hooks it runs (`GIT_DIR`,
 * `GIT_INDEX_FILE`, …). From a linked worktree they are absolute paths into the
 * shared `.git`, so a test that runs `git init`/`git commit` in its own temp
 * repo writes into the real repository instead: commits, branches and config
 * (`core.bare`, `user.name`) of every worktree. The list is the output of
 * `git rev-parse --local-env-vars`.
 */
const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const;

/** A copy of `env` without the variables that pin git to a repository. */
export function testSuiteEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  const drop = new Set<string>(GIT_LOCAL_ENV_VARS);
  for (const [key, value] of Object.entries(env)) {
    if (
      value === undefined ||
      drop.has(key) ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_')
    )
      continue;
    result[key] = value;
  }
  return result;
}

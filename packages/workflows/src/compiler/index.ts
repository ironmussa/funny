/**
 * @funny/workflows/compiler — compiles a parsed workflow into a pipeline that
 * `@funny/pipelines` runs, calling an `ActionProvider` for every action.
 *
 * A subpath of its own so browser consumers of `@funny/workflows` do not pull
 * in the engine. Each host (the runtime, the issue factory's step runner)
 * supplies its own `ActionProvider`.
 */

export * from './action-provider.js';
export * from './approval.js';
export * from './yaml-compiler.js';

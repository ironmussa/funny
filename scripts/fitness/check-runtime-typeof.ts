#!/usr/bin/env bun
/**
 * Fitness function: no `anti-slop/no-runtime-typeof` finding under the given
 * directories (issue #459 cleared it in packages/server and packages/runtime).
 *
 * Runs the vendored rule itself (tools/oxlint/anti-slop/rules/no-runtime-typeof.ts)
 * with the option oxlint.config.ts gives it (`allowInTypeGuards: true`) over
 * the ESTree oxc-parser produces, the AST oxlint hands its JS plugins. It does
 * not need `bun lint`, which only Bun canary has, so the package test suites
 * can call it on the pinned Bun of CI. Test files are skipped, as the config
 * turns the rule off for them.
 *
 *   bun scripts/fitness/check-runtime-typeof.ts packages/server/src [...]
 *   bun scripts/fitness/check-runtime-typeof.ts --self-test
 *
 * Prints one `file:line:col` per finding and exits 1 when there is any.
 */

import { noRuntimeTypeofRule } from '../../tools/oxlint/anti-slop/rules/no-runtime-typeof.ts';
import { runRuleCheck, walkProgram, type AstNode, type RuleFinding } from './oxc-rule-check.ts';

const RULE_OPTIONS = [{ allowInTypeGuards: true }];

/** The `typeof` expressions the rule reports in `source`. */
function findRuntimeTypeof(fileName: string, source: string): RuleFinding[] {
  const reported: RuleFinding[] = [];
  // SAFETY: the rule reads only `context.options` and calls `context.report({ node })`
  // (tools/oxlint/anti-slop/rules/no-runtime-typeof.ts); this object provides both.
  const context = {
    options: RULE_OPTIONS,
    report: ({ node }: { node: AstNode }) => reported.push({ offset: node.start }),
  } as never;
  const onUnary = noRuntimeTypeofRule.createOnce(context).UnaryExpression;
  if (!onUnary) throw new Error('no-runtime-typeof has no UnaryExpression visitor');
  walkProgram(fileName, source, (node) => {
    if (node.type !== 'UnaryExpression') return;
    // SAFETY: oxc-parser builds the ESTree oxlint gives its JS plugins, and
    // `walkProgram` set `parent` on this node and every ancestor, which is all the rule reads.
    onUnary(node as never);
  });
  return reported;
}

if (import.meta.main) {
  runRuleCheck('no-runtime-typeof', findRuntimeTypeof, [
    ['const a = (v: unknown) => typeof v === "string";', 1],
    ['function g(v: unknown): v is string { return typeof v === "string"; }', 0],
    ['const ok = typeof window === "undefined";', 0],
    ['function g(v: unknown): v is string { return [v].some((x) => typeof x === "string"); }', 1],
    ['type T = typeof import("x");', 0],
  ]);
}

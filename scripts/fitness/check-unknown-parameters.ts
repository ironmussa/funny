#!/usr/bin/env bun
/**
 * Fitness function: no `anti-slop/no-unknown-parameters` finding under the
 * given directories (issue #525 cleared it in packages/client/src).
 *
 * Runs the vendored rule itself (tools/oxlint/anti-slop/rules/no-unknown-parameters.ts)
 * over the ESTree oxc-parser produces, the AST oxlint hands its JS plugins, like
 * check-runtime-typeof.ts. It does not need `bun lint`, which only Bun canary
 * has, so the package test suites can call it on the pinned Bun of CI. Test
 * files are skipped, as oxlint.config.ts turns the rule off for them.
 *
 *   bun scripts/fitness/check-unknown-parameters.ts packages/client/src [...]
 *   bun scripts/fitness/check-unknown-parameters.ts --self-test
 *
 * Prints one `file:line:col: no-unknown-parameters (name)` per finding and
 * exits 1 when there is any.
 */
import { noUnknownParametersRule } from '../../tools/oxlint/anti-slop/rules/no-unknown-parameters.ts';
import { runRuleCheck, walkProgram, type AstNode, type RuleFinding } from './oxc-rule-check.ts';

/** The parameters the rule reports in `source`. */
function findUnknownParameters(fileName: string, source: string): RuleFinding[] {
  const findings: RuleFinding[] = [];
  // SAFETY: the rule reads only `context.sourceCode.getText(node)` and calls
  // `context.report({ node, data })` (rules/no-unknown-parameters.ts and
  // shared/function-parameters.ts); this object provides both.
  const context = {
    sourceCode: { getText: (node: AstNode) => source.slice(node.start, node.end) },
    report: ({ node, data }: { node: AstNode; data: { parameter: string } }) =>
      findings.push({ offset: node.start, detail: data.parameter }),
  } as never;
  const visitors: Partial<Record<string, (node: never) => void>> =
    noUnknownParametersRule.createOnce(context);
  walkProgram(fileName, source, (node) => {
    // SAFETY: oxc-parser builds the ESTree oxlint gives its JS plugins; the rule
    // reads only the parameters and return type of the node it visits.
    visitors[node.type]?.(node as never);
  });
  return findings;
}

if (import.meta.main) {
  runRuleCheck('no-unknown-parameters', findUnknownParameters, [
    ['function f(value: unknown) {}', 1],
    ['const f = (value: string | unknown) => value;', 1],
    ['function g(value: unknown): value is string { return true; }', 0],
    ['function h(cause: unknown) {}', 0],
    ['const k = (value: number | undefined) => value;', 0],
  ]);
}

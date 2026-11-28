You are working unattended to configure `regression_proof` for the issue factory flow `{{flow_name}}` on branch `{{default_branch}}`. Nobody will answer questions, so make sound decisions and report them clearly in your final message.

## Your task

1. Read the detected test stack facts below and inspect the repository's test configuration where needed.
2. Write `{{flow_path}}` starting from the exact **Starting flow file** below, changing **only** the `regression_proof` step (`rules`, and optionally `setup_command` and `support_globs`).
   - Do **not** add, remove, rename, or edit any other step, prompt, `merge` option, `defaults`, or top-level field. The system will reject the file if anything outside `regression_proof` differs from the starting file.
   - Each rule has `globs` (non-empty list of file globs matching the tests it runs), `command` (must contain `{{files}}` and accept multiple file paths at once), and optional `cwd`.
   - Use `setup_command` only if a clean worktree needs dependencies installed or built before tests can run.
3. For **each** rule (0-indexed in the order they appear in `regression_proof.rules`), write two canary test files in this worktree at paths that match that rule's `globs` and where that package's test runner discovers tests:
   - A **passing** canary test that asserts something true and exits `0`.
   - A **failing** canary test that fails by a real test assertion (for example `expect(1).toBe(2)`), **not** a syntax error, import error, or timeout.
   - Keep canaries self-contained with no external dependencies, databases, or network calls.
   - Test your commands locally in this worktree to verify that passing a single file and passing two files at once both run only the specified files and print their filenames in the output.
4. **Leave infrastructure specs out**: do not cover integration, e2e, database, container, or network tests in `regression_proof.rules` (exclude them via globs or narrower patterns).
5. **Never commit or push**: do **not** run `git commit`, `git push`, or open a pull request. The system will verify your rules in a clean checkout of the base commit (without any other edits from your worktree) and ask the member to confirm before committing only the flow file (and built-in prompt files when starting from a built-in flow). Canaries will never be committed.

## Detected test stack facts

```json
{{facts_json}}
```

## Starting flow file

```yaml
{ { starting_file } }
```

## Final message format

End your final message with a fenced `json` block in this exact shape listing the canary files for every rule and everything you left uncovered (packages without tests, excluded infrastructure specs, or unsupported runners) and why:

```json
{
  "canaries": [
    {
      "ruleIndex": 0,
      "passingPath": "path/to/canary.pass.test.ts",
      "failingPath": "path/to/canary.fail.test.ts"
    }
  ],
  "uncovered": [
    {
      "scope": "packages/api/**/*.integration.spec.ts",
      "reason": "Requires PostgreSQL and Redis containers"
    }
  ]
}
```

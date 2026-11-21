## Breaking change: `on_error: continue` lets the joins decide

**Before.** A node with `on_error: continue` that failed was treated as if it had succeeded:
its dependents ran as usual.

**After.** The node is marked failed and the run goes on according to each dependent's join.
With the default join (`trigger_rule: all_success`) a dependent of a failed node is
**skipped**. The run still ends `completed`.

```yaml
nodes:
  - id: tests
    run_command: { command: bun test }
    on_error: continue
  - id: notify
    depends_on: [tests]
    notify: { message: 'Review finished' } # skipped now when tests fails
```

**Migration.** For every node that depends on a node with `on_error: continue`:

- if it must run after the failure (the old behavior), add `trigger_rule: all_done`;
- if it must not run when the dependency fails, add `trigger_rule: all_success` explicitly.

**How you find out.** The parser warns on every such dependent that declares no
`trigger_rule`: _"`notify` is skipped if `tests` fails (on_error: continue). Add
`trigger_rule: all_done` if it must run anyway."_ The warning shows in the workflow editor
(saving and running stay enabled), comes back from the workflow API as a diagnostic with
`severity: 'warning'`, and is logged when the runtime or the factory loads the flow. Declaring
any `trigger_rule` on the dependent silences it.

The bundled flows are already migrated (`fusion` and `code-quality` use `all_done`) and load
with no warnings. Only flows in a repository's `.funny/workflows/` can be affected.

# Spec Delta

## ADDED Requirements

### Requirement: A flow warns about dependents a continued failure skips

When a node has `on_error: continue` and another node depends on it without declaring a
`trigger_rule`, parsing the flow SHALL report a warning on the dependent that names both nodes
and says that adding `trigger_rule: all_done` makes it run after the failure. A warning SHALL
NOT make the flow invalid: the flow SHALL still load, save and run. Declaring any
`trigger_rule` on the dependent SHALL suppress the warning. Every diagnostic SHALL have a
severity of `error` or `warning`; a diagnostic with no stated severity SHALL be treated as an
error.

#### Scenario: A dependent on the default join is warned

- **WHEN** node `tests` has `on_error: continue` and node `notify` has `depends_on: [tests]`
  and no `trigger_rule`
- **THEN** the flow parses as valid and reports one warning on `notify` that names `tests`
  and suggests `trigger_rule: all_done`

#### Scenario: An explicit trigger rule silences the warning

- **WHEN** the same flow gives `notify` `trigger_rule: all_success` or `trigger_rule: all_done`
- **THEN** the flow parses as valid and reports no warning

#### Scenario: Nodes that continue without dependents are not warned

- **WHEN** a node has `on_error: continue` and no node depends on it
- **THEN** the flow reports no warning

#### Scenario: A warning does not block the editor

- **WHEN** the workflow editor shows a flow whose only diagnostics are warnings
- **THEN** the warnings are visible and saving and running the flow stay enabled

#### Scenario: An error still blocks the editor

- **WHEN** the workflow editor shows a flow with at least one error diagnostic
- **THEN** saving and running the flow are disabled

#### Scenario: Warnings are logged when a flow is loaded

- **WHEN** the runtime or the factory loads a flow that has warnings
- **THEN** each warning is logged with the flow name and the node path, and the flow is used
  as loaded

# agent-process-termination Specification

## Purpose

TBD - created by archiving change agent-idle-reaper. Update Purpose after archive.

## Requirements

### Requirement: Whole-tree termination of agent processes

When an agent process is terminated, the system SHALL terminate the entire descendant process tree of that agent, including MCP servers and any other grandchildren the agent spawned, so that no descendant is left orphaned (reparented to init / still resident) after the agent exits.

#### Scenario: ACP agent with MCP children is killed

- **WHEN** an ACP agent process (e.g. `codex-acp`) that has spawned one or more MCP server child processes is terminated via `kill()`
- **THEN** the ACP process and all of its MCP server descendants are no longer running

#### Scenario: No orphaned grandchildren remain

- **WHEN** an agent process tree is terminated
- **THEN** no descendant process of the original agent remains running or reparented to the init process

#### Scenario: Applies uniformly across all ACP providers

- **WHEN** any ACP-based agent (codex, gemini, pi, cursor, opencode, or an external/installed provider) with descendant processes is terminated
- **THEN** the whole-tree termination behavior applies identically, because all ACP providers share one process implementation

### Requirement: Termination applies on every kill path

Every code path that ends an agent process — manual stop, thread delete, respawn for incompatible options, and idle reaping — SHALL use whole-tree termination. No kill path may signal only the immediate child.

#### Scenario: Manual stop terminates the tree

- **WHEN** a user stops a running agent
- **THEN** the agent process and all descendants are terminated

#### Scenario: Respawn for changed options terminates the prior tree

- **WHEN** the orchestrator must respawn an agent because the new request's options are incompatible with the live process
- **THEN** the prior agent process and all of its descendants are terminated before the new process is started

### Requirement: Cross-platform termination

Whole-tree termination SHALL work on both POSIX and Windows platforms.

#### Scenario: POSIX process-group termination

- **WHEN** an agent process is terminated on a POSIX platform
- **THEN** the agent's process group receives a termination signal, followed by a forceful kill if the group does not exit within a grace period

#### Scenario: Windows tree termination

- **WHEN** an agent process is terminated on Windows
- **THEN** the agent process and its child tree are terminated together

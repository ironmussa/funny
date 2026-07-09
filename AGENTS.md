# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Verification

- Always run `bun run lint` and `bun run typecheck` before considering code changes complete.
- Add or update a test when a change affects behavior, fixes a bug, or introduces enough risk that automated coverage is warranted.

## OpenWiki

Structured documentation for this repository lives in [openwiki/quickstart.md](openwiki/quickstart.md):
repository overview, architecture, agent-execution flow, pipelines/automation, thread & worktree
domain rules, integrations/standalone services, operations/auth, and the development workflow.
Consult it when searching for context about how this codebase works.

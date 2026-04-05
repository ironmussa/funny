# CLAUDE.md — Paisley Park Memory System

This file instructs agents on how to use the Paisley Park project memory system. When Paisley Park is active, you have MCP tools to read and write project memory during your session.

## What is Paisley Park?

Paisley Park is a shared project memory system. It stores **facts** — non-obvious knowledge that cannot be derived from code, git history, or file structure. Facts persist across sessions and are shared with all agents and team members working on the same project.

Memory is **not** a notebook or a log. It is a curated knowledge base. Every fact must earn its place.

## Available Tools

| Tool | Purpose |
|------|---------|
| `pp_recall` | Search memory for facts relevant to a query |
| `pp_add` | Store a new fact |
| `pp_invalidate` | Mark a fact as no longer valid |
| `pp_search` | Search with filters (type, tags) |
| `pp_evolve` | Update an existing fact with new information |

## When to Use Memory

### Before starting work: RECALL

**Always recall before starting a non-trivial task.** Check if there are decisions, conventions, known issues, or patterns related to what you are about to do.

```
pp_recall("authentication flow")
pp_recall("database migration conventions")
pp_recall("known issues with the payment module")
```

Good recall queries are specific to the task at hand. Do not recall generic terms like "project" or "code".

### During work: ADD

Store knowledge when you discover something **non-obvious** that future agents or team members should know. Ask yourself: "Could someone derive this by reading the code or running `git log`?" If yes, do not store it.

**Good facts to store:**

- **Decisions** — "We chose event sourcing for the audit log because compliance requires full traceability of all admin actions"
- **Bug root causes** — "The intermittent 502s on /api/export are caused by the worker pool exhausting connections when reports exceed 10k rows. The pool is intentionally limited to 5 to protect the read replica."
- **Patterns** — "All webhook handlers follow the idempotency pattern: check event_id in processed_events table before executing, to survive retries"
- **Conventions** — "Error responses always use the ApiError class from shared/errors.ts, never raw throw. This ensures consistent error shape for the client."
- **Insights** — "The billing service uses eventual consistency — invoice totals may lag up to 30 seconds after line item changes. Tests that assert immediately after writes will be flaky."
- **Context** — "Merge freeze starts 2026-04-10 for the mobile release cut. No non-critical PRs after that date."

**Bad facts (do NOT store):**

- File paths, directory structure ("the auth module is in packages/server/src/auth")
- Function signatures, class definitions, imports ("the parseConfig function takes a string and returns Config")
- Git history, blame, commit messages, PR details ("PR #123 added the new endpoint")
- Test results, build output, stack traces ("test suite passed with 94% coverage")
- Package versions ("hono is at version 4.7.10")
- Anything you can learn by reading the code or running a command

### When facts become stale: INVALIDATE

When you discover that a previously stored fact is no longer accurate, invalidate it immediately. Stale memories are worse than no memories.

```
pp_invalidate("fact-2025-03-15-a1b2", "The pool size was increased to 20 in the last migration")
```

### When facts need updates: EVOLVE

When a fact is still valid but needs refinement or additional context, evolve it rather than creating a new one.

```
pp_evolve("fact-2025-03-15-a1b2", "Pool size was later increased to 20, but the connection limit on the replica is still 50")
```

## Fact Types

Choose the most specific type when adding a fact:

| Type | Decay | Use when... |
|------|-------|-------------|
| `decision` | slow (~231 day half-life) | Recording an architectural or design choice and its rationale |
| `bug` | normal (~46 day half-life) | Documenting a root cause, workaround, or debugging insight |
| `pattern` | slow (~231 day half-life) | Describing a recurring code/architecture pattern in the project |
| `convention` | slow (~231 day half-life) | Recording a team agreement or project standard |
| `insight` | normal (~46 day half-life) | Noting a non-obvious observation or learning |
| `context` | fast (~14 day half-life) | Capturing temporary information (sprint goals, freezes, incidents) |

Decay means facts that are never accessed again gradually lose relevance. Important facts that keep getting recalled stay fresh.

## Writing Good Facts

1. **Be concise** — Maximum 3 sentences. If it takes a paragraph to explain, it might be too detailed.
2. **Include the WHY** — "We use X" is less useful than "We use X because Y". The rationale is the valuable part.
3. **Use absolute dates** — Write "2026-04-10" not "next Thursday". Facts persist across sessions.
4. **Be specific** — "The billing module is slow" is useless. "The billing module's invoice generation takes 8+ seconds for accounts with >1000 line items because it recalculates tax per-line without batch optimization" is useful.
5. **One fact, one topic** — Don't combine unrelated information into a single fact.

## Memory is Not Ground Truth

Memories may be stale. The codebase evolves faster than memory can track. When you recall a fact:

- **Verify before acting** — If a fact says "function X uses pattern Y", check the current code before assuming it's still true.
- **Update or invalidate stale facts** — If you find a fact that no longer matches reality, fix it.
- **Trust current code over memory** — When memory conflicts with what you observe in the codebase, the codebase wins.

## How Memory Works Internally

### Storage
Facts are stored in a libSQL database (SQLite-compatible). In team setups, all instances sync via embedded replicas — writes from any team member propagate to everyone automatically.

### Retrieval
When you call `pp_recall`, the system:
1. Runs **embedding search** (70% weight) — semantic similarity via vector embeddings
2. Runs **keyword search** (30% weight) — term matching on content and tags
3. **Graph traversal** — follows `related` links from top results to find connected facts
4. **Ranking** — filters by validity and confidence, applies temporal decay

### Garbage Collection
A background process periodically:
- Archives facts with very low decay scores (not accessed in a long time)
- Deduplicates near-identical facts
- Cleans up orphaned fast-decay facts

### Consolidation
If an LLM consolidation agent is configured, it periodically:
- Groups similar facts and merges them into concise summaries
- Rejects new facts that contain derivable information (admission filter)
- Ensures only one instance consolidates at a time (distributed lock)

## Tags

Use tags to categorize facts for easier filtering. Good tag conventions:

- Module/area: `auth`, `billing`, `api`, `frontend`, `database`
- Concern: `security`, `performance`, `compliance`, `migration`
- Team: `platform`, `mobile`, `data`

Tags are lowercase, hyphen-separated. Keep them short and consistent.

## Examples

### Starting a task

```
User: "Add rate limiting to the /api/export endpoint"

Agent thinks: "Let me check if there are any known issues or conventions about rate limiting or this endpoint."

→ pp_recall("rate limiting conventions")
→ pp_recall("api export endpoint known issues")
```

### After discovering something important

```
Agent discovers that the export endpoint streams responses and cannot use the standard middleware.

→ pp_add(
    "The /api/export endpoint uses streaming responses (Transfer-Encoding: chunked), so the standard rate-limit middleware (which buffers the response to count bytes) cannot be applied. Rate limiting must be done at the request level before the stream starts.",
    type: "insight",
    tags: ["api", "rate-limiting", "export"]
  )
```

### Fixing a stale fact

```
Agent recalls a fact saying "Rate limiting uses Redis" but discovers it was migrated to in-memory.

→ pp_invalidate("fact-2025-02-10-x1y2", "Rate limiting was migrated from Redis to in-memory sliding window in March 2026")
```

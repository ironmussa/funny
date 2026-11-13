# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`openspec/`**: when working inside an open change, read its `openspec/changes/<change>/design.md` (see **ADRs and openspec** below).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is single-context: one product vocabulary shared by every package.

```
/
├── GLOSSARY.md
├── docs/adr/
│   └── 0001-<decision>.md
├── openspec/
│   ├── changes/<change>/   ← proposal, design, tasks of one change
│   └── specs/              ← living specs
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## ADRs and openspec

`openspec/` holds each change's proposal, design and tasks (`openspec/changes/<change>/`) and the
living specs (`openspec/specs/`). Read the change's `design.md` when working inside an open change.

An ADR records a decision that is hard to reverse and must keep holding after its openspec change is
archived (e.g. "the runner never has a database", "requests never fall back to another user's runner").
When a change settles such a decision, the ADR is the durable record; the change's design.md may link to it.

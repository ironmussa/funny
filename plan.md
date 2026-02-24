# Plan: Slim Down packages/agent → Estilo Agent Orchestrator

## Objetivo
Eliminar quality pipeline Y merge automation. Solo queda:
**Issue → Agent planifica → Agent codea → Crear PR → Reactions (CI fail / review feedback)**

---

## Qué se ELIMINA (~5,500 líneas, ~40 archivos)

### Core (eliminar archivos completos)
- `core/pipeline-runner.ts` (409 líneas) — Quality pipeline orchestrator
- `core/quality-pipeline.ts` (339) — Ejecución paralela de agentes de calidad
- `core/agent-roles.ts` (342) — 9 agentes de calidad (tests, security, arch, etc.)
- `core/tier-classifier.ts` (75) — Clasificación small/medium/large
- `core/integrator.ts` (507) — Merge automation + conflict resolution
- `core/merge-scheduler.ts` (263) — Cola de merge con dependencias/prioridad
- `core/manifest-manager.ts` (284) — manifest.json tracking
- `core/manifest-types.ts` (105) — Tipos del manifest
- `core/branch-cleaner.ts` (180) — Limpieza de ramas pipeline/integration
- `core/saga.ts` (146) — Saga pattern (solo usado por Integrator)

### Infrastructure (eliminar)
- `infrastructure/circuit-breaker.ts` (59)
- `infrastructure/idempotency.ts` (84)
- `infrastructure/dlq.ts` (185)
- `infrastructure/adapter.ts` (113)
- `infrastructure/webhook-adapter.ts` (68)
- `infrastructure/rate-limiter.ts` (100)
- `infrastructure/request-logger.ts` (207)
- `infrastructure/container-manager.ts` (144)
- `infrastructure/message-publisher.ts` (134)
- `infrastructure/service-container.ts` (83)

### Routes (eliminar)
- `routes/pipeline.ts` (236)
- `routes/merge-scheduler.ts` (49)
- `routes/logs.ts` (58)

### Listeners (eliminar TODOS)
- `listeners/manifest-writer.ts` (45)
- `listeners/merge-scheduler-trigger.ts` (27)
- `listeners/rebase-trigger.ts` (34)
- `listeners/pipeline-cleanup.ts` (40)
- `listeners/merge-cleanup.ts` (43)
- `listeners/idempotency-releaser.ts` (23)

### Hatchet (eliminar TODO el directorio)
- `hatchet/client.ts` (29)
- `hatchet/worker.ts` (52)
- `hatchet/workflows/feature-to-deploy.ts` (312)
- `hatchet/workflows/issue-to-pr.ts` (515)
- `hatchet/workflows/pr-review-loop.ts` (260)
- `hatchet/workflows/doc-gardening.ts` (158)
- `hatchet/workflows/backlog-processor.ts` (240)
- `hatchet/workflows/cleanup.ts` (167)

### Tests (eliminar los de componentes eliminados)
- `__tests__/merge-scheduler.test.ts`
- `__tests__/manifest-manager.test.ts`
- `__tests__/dlq.test.ts`
- `__tests__/idempotency.test.ts`
- `__tests__/saga.test.ts`
- `__tests__/tier-classifier.test.ts`
- `__tests__/webhook-adapter.test.ts`
- `__tests__/webhooks-review-loop.test.ts`
- `__tests__/request-logger.test.ts`

---

## Qué se QUEDA (~2,500 líneas)

### Core
- `core/orchestrator-agent.ts` (467) — Planifica + implementa issues
- `core/session.ts` (276) — Modelo de sesión
- `core/session-store.ts` (180) — Persistencia
- `core/reactions.ts` (234) — CI fail / review reactions
- `core/types.ts` (~50 simplificado) — Solo tipos necesarios
- `core/state-machine.ts` (101) — FSM genérico
- `core/errors.ts` (105) — Errores

### Infrastructure
- `infrastructure/event-bus.ts` (100) — Pub/sub
- `infrastructure/logger.ts` (28) — Logger
- `infrastructure/async-mutex.ts` (58) — Mutex

### Routes
- `routes/sessions.ts` (477, simplificar) — Quitar Hatchet/pipeline refs
- `routes/webhooks.ts` (304, simplificar) — Quitar Hatchet refs

### Trackers
- `trackers/tracker.ts` (80) — Interfaz
- `trackers/github-tracker.ts` (192) — GitHub

### Config (simplificar)
- `config/schema.ts` — Quitar: tiers, quality agents, auto_correction, resilience, merge_scheduler, adapters, cleanup, webhook_secret
- `config/defaults.ts` — Quitar defaults correspondientes
- `config/loader.ts` — Sin cambios

### Validation
- `validation/schemas.ts` — Solo StartSessionSchema

### Entry points
- `index.ts` — Reescribir (solo wiring mínimo)
- `server.ts` — Simplificar (quitar Hatchet)

### Tests que quedan
- `__tests__/config-schema.test.ts` (actualizar)
- `__tests__/config-defaults.test.ts` (actualizar)
- `__tests__/config-loader.test.ts` (actualizar)
- `__tests__/event-bus.test.ts` (sin cambios)
- `__tests__/state-machine.test.ts` (sin cambios)
- `__tests__/async-mutex.test.ts` (sin cambios)
- `__tests__/github-cli.test.ts` (sin cambios)

---

## Flujo resultante

```
1. POST /sessions/start { issue_number, project_path }
2. GitHubTracker.fetchIssue()
3. Session creada → planning
4. OrchestratorAgent.planIssue() — LLM explora codebase
5. Session → implementing
6. Crear worktree
7. OrchestratorAgent.implementIssue() — LLM codea + commitea
8. Push + crear PR (gh CLI)
9. Session → pr_created → ci_running
10. GitHub webhook: CI passed/failed
    → failed: ReactionEngine respawnea agente (max 3x)
    → passed: Session → ci_passed
11. GitHub webhook: review
    → changes_requested: ReactionEngine respawnea (max 2x)
    → approved: notify o auto-merge
```

---

## Orden de ejecución

1. Eliminar ~40 archivos
2. Simplificar config/schema.ts y config/defaults.ts
3. Simplificar core/types.ts (quitar Pipeline*, AgentName, Tier, etc.)
4. Reescribir index.ts (wiring mínimo)
5. Simplificar server.ts (quitar Hatchet)
6. Simplificar routes/sessions.ts (quitar Hatchet + pipeline refs)
7. Simplificar routes/webhooks.ts (quitar Hatchet refs)
8. Simplificar validation/schemas.ts
9. Eliminar tests obsoletos, actualizar config tests
10. Verificar compilación con bunx tsc --noEmit

# PLAN — Symphony sobre funny + Archon

**Estado:** Borrador v1 (2026-05-09)
**Alcance:** Implementar la semántica de orquestación de [OpenAI Symphony](https://github.com/openai/symphony/blob/main/SPEC.md) usando `funny` como tracker (en lugar de Linear) y [Archon](https://github.com/coleam00/Archon) como executor de workflows.

---

## 1. Contexto y objetivo

Symphony es un *daemon orquestador* que polea un issue tracker, mantiene un agente Codex corriendo por cada issue activo, y delega la actualización de estado al propio agente. El SPEC tiene ~2.200 líneas pero el núcleo (poll + slots + retry + reconcile) es chico.

**Objetivo concreto:** dado un thread en el kanban de funny en `stage = in_progress`, el sistema debe automáticamente:

1. Detectarlo (poll/event-driven).
2. Validar elegibilidad (slot disponible, dependencias resueltas, no `running` ya).
3. Crear worktree + lanzar agente vía Archon DAG.
4. Reintentar con backoff si crashea, detectar stalls, propagar cancelación.
5. Permitir que el agente actualice `thread.status` / `thread.stage` desde dentro de la sesión.

**No es objetivo:** reescribir Archon, soportar Linear, ni reimplementar el ejecutor DAG.

---

## 2. Arquitectura — tres capas

```
┌──────────────────────────────────────────────────────────────┐
│ funny (tracker + UI + auth + DB)                             │
│  - threads(stage, status, ...) ya existe                     │
│  - WS broker emite thread:stage-changed, thread:created      │
│  - Repos en packages/shared/repositories                     │
└───────────────┬──────────────────────────────────────────────┘
                │ events / repo reads
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Orchestrator (NUEVO — packages/core/src/orchestrator/)       │
│  - poll loop + reconcile tick (§9.5)                         │
│  - eligibility query (§7.4)                                  │
│  - slot manager (max_concurrent_agents global y por user)    │
│  - retry scheduler con backoff exponencial (§9.3)            │
│  - stall detector (§9.4) — observa eventos del run           │
│  - dispatcher → invoca Archon                                │
│  Pure logic, neverthrow Result<T,E>                          │
└───────────────┬──────────────────────────────────────────────┘
                │ executeWorkflow(symphony-thread.yaml, ctx)
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Archon (executor)                                            │
│  - DAG runner (packages/workflows/src/executor.ts)           │
│  - worktree mgmt + agent spawn                               │
│  - per-node retry + idle-timeout (STEP_IDLE_TIMEOUT_MS)      │
│  - tool calls back to funny: update_thread_status, comment   │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Por qué tres capas y no dos

Si funny llamara directo a Archon cuando un thread entra a `in_progress`, perderíamos:

- **Slot cap global** (§7.3): 50 threads en `in_progress` = 50 agentes simultáneos.
- **Retry/backoff por issue** (§9.3): el retry de Archon es per-DAG-node; el de Symphony es per-issue.
- **Reconcile** (§9.5): si Archon muere mientras funny dice "running", nadie detecta divergencia.
- **Priority sort** (§7.5): el orchestrator decide *qué* pedir cuando hay más demanda que slots.

---

## 3. Modelo de datos

### 3.1 Threads de funny — los dos ejes

Confirmado en `packages/shared/src/primitives.ts`:

```ts
type ThreadStatus =
  'setting_up' | 'idle' | 'pending' | 'running' |
  'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';

type ThreadStage =
  'backlog' | 'planning' | 'in_progress' | 'review' | 'done' | 'archived';
```

### 3.2 Mapeo Symphony → funny (sin tabla nueva)

| Estado interno Symphony | Predicado SQL en funny |
|---|---|
| `Unclaimed` (candidato) | `stage IN ('backlog','planning','in_progress') AND status NOT IN ('running','setting_up')` |
| `Claimed` (elegido, aún no run) | `status = 'setting_up'` |
| `Running` | `status = 'running'` |
| `RetryQueued` | `status = 'waiting'` |
| `Released` (terminal del run) | `status IN ('completed','failed','stopped','interrupted')` |
| Issue terminal en tracker | `stage IN ('done','archived')` |

**Conclusión:** la matriz `(stage × status)` ya cubre la máquina de estados de Symphony. **Cero columnas nuevas en `threads`.**

### 3.3 Tablas nuevas (mínimas)

```sql
-- Bloqueos entre threads (opcional v2; diferible para v1)
CREATE TABLE thread_dependencies (
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  blocked_by    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, blocked_by)
);

-- Estado del orchestrator por thread (ephemeral, pero persistido para resume)
CREATE TABLE orchestrator_runs (
  thread_id          TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  workflow_run_id    TEXT,                 -- FK lógica al workflow_runs de Archon
  attempt            INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms   INTEGER,              -- backoff target
  last_event_at_ms   INTEGER NOT NULL,     -- para stall detection
  last_error         TEXT,
  claimed_at_ms      INTEGER NOT NULL,
  user_id            TEXT NOT NULL,        -- denormalizado para queries de slot por user
  updated_at_ms      INTEGER NOT NULL
);
CREATE INDEX idx_orch_runs_user ON orchestrator_runs(user_id);
CREATE INDEX idx_orch_runs_retry ON orchestrator_runs(next_retry_at_ms)
  WHERE next_retry_at_ms IS NOT NULL;
```

**Por qué persistir y no in-memory como Symphony §3:** funny ya persiste todo, ganamos resume gratis. Si el server reinicia, el orchestrator reconstruye desde `orchestrator_runs` + estado actual de threads.

---

## 4. Diseño del Orchestrator

### 4.1 Ubicación de paquetes

| Capa | Paquete | Por qué |
|---|---|---|
| Pure logic (eligibility, sort, backoff math) | `packages/core/src/orchestrator/` | CLAUDE.md exige `Result<T,E>` en core; sin HTTP/DB |
| Singleton + lifecycle | `packages/server/src/services/orchestrator-service.ts` | Server es dueño de la DB y el lifecycle |
| Adapter Archon | `packages/server/src/services/archon-dispatcher.ts` | Wrapper sobre Archon CLI/API |
| Repo SQL | `packages/shared/src/repositories/orchestrator-run-repository.ts` | Convención existente |

### 4.2 Interfaces principales (TypeScript)

```ts
// packages/core/src/orchestrator/types.ts
import type { Result, ResultAsync } from 'neverthrow';
import type { Thread } from '@funny/shared';

export interface SlotPolicy {
  maxConcurrentGlobal: number;       // ej. 16
  maxConcurrentPerUser: number;      // ej. 4
}

export interface EligibilityInput {
  candidates: Thread[];              // stage IN (...) AND status NOT IN (...)
  running: Map<string, RunRef>;      // threadId → run ref
  claimed: Set<string>;              // threadIds en setting_up
  retryQueue: Map<string, RetryEntry>;
  dependencies: Map<string, string[]>; // threadId → blocked_by_thread_ids
  slots: SlotPolicy;
  now: number;
}

export interface DispatchPlan {
  toDispatch: Thread[];              // ya ordenados por priority+created_at
  toRetry: Thread[];                 // retry due
  toReconcile: Thread[];             // estado divergente con tracker
}

export function planDispatch(input: EligibilityInput): Result<DispatchPlan, OrchestratorError>;

// Backoff puro
export function nextRetryDelayMs(attempt: number, max: number): number;

// Detección de stall
export function isStalled(run: RunRef, stallTimeoutMs: number, now: number): boolean;
```

```ts
// packages/server/src/services/orchestrator-service.ts
export class OrchestratorService {
  private running = new Map<string, RunRef>();
  private claimed = new Set<string>();
  private retryQueue = new Map<string, RetryEntry>();

  start(): void;          // loop con setInterval(tick, pollIntervalMs)
  stop(): Promise<void>;  // grace shutdown — no mata runs en curso
  refresh(): Promise<void>; // POST /api/orchestrator/refresh — invoca tick fuera de turno

  private async tick(): Promise<void> {
    // 1. reconcile (cargar orchestrator_runs + threads del DB)
    // 2. fetch candidates (eligibility query)
    // 3. planDispatch (pure logic)
    // 4. execute plan: dispatch / retry / reconcile
    // 5. emit WS events: orchestrator:tick, thread:claimed, thread:dispatched
  }
}
```

### 4.3 Eligibility query (§7.4)

```sql
SELECT t.* FROM threads t
WHERE t.user_id = ?
  AND t.stage IN ('backlog', 'planning', 'in_progress')
  AND t.status NOT IN ('running', 'setting_up', 'completed')
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_runs r WHERE r.thread_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM thread_dependencies d
    JOIN threads bt ON bt.id = d.blocked_by
    WHERE d.thread_id = t.id
      AND bt.stage NOT IN ('done', 'archived')
  )
ORDER BY t.priority ASC NULLS LAST, t.created_at ASC, t.id ASC
LIMIT ?;
```

### 4.4 Backoff (§9.3)

```ts
// Symphony: min(10000 * 2^(attempt-1), max_retry_backoff_ms). attempt=1 → 10s.
// Para v1: max_retry_backoff_ms = 5min. Continuation post-clean = 1s fija.
export function nextRetryDelayMs(attempt: number, maxMs = 300_000): number {
  if (attempt <= 0) return 1_000;
  return Math.min(10_000 * Math.pow(2, attempt - 1), maxMs);
}
```

### 4.5 Stall detection (§9.4)

Reusar `withIdleTimeout()` de Archon (`packages/workflows/src/utils/idle-timeout.ts`) — wrappa el async generator del DAG y mata si no hay yields en N ms. **No reimplementar** — Archon lo hace mejor que el SPEC. El orchestrator sólo configura `STEP_IDLE_TIMEOUT_MS` por workflow.

### 4.6 Reconcile tick (§9.5)

Cada 30s:

1. Para cada `orchestrator_runs` activo: si Archon dice `failed`/`cancelled` pero funny dice `running` → reset `status='waiting'`, marcar retry.
2. Para cada `thread.stage IN ('done','archived')` con `orchestrator_runs` vivo → cancelar run en Archon, limpiar entry.
3. Para cada `running` map entry sin proceso real (post-restart del server) → reload desde `working_path` de Archon (mig 019) o marcar para retry.

---

## 5. Integración con Archon

### 5.1 Workflow YAML — `symphony-thread.yaml`

Vive en cada repo de `funny` (`.archon/workflows/symphony-thread.yaml`). Mínimo:

```yaml
name: symphony-thread
inputs:
  - thread_id
  - prompt
  - branch
  - mode  # local | worktree

nodes:
  - id: setup
    type: bash
    run: git worktree add -b {{ branch }} ../{{ thread_id }}
    when: "{{ mode == 'worktree' }}"

  - id: agent
    type: prompt
    provider: claude
    prompt_file: prompts/agent.md
    context:
      thread_id: "{{ thread_id }}"
    tools: [update_thread_status, post_thread_comment, ...]
    retry:
      max_attempts: 3
      delay_ms: 2000
      on_error: transient
    idle_timeout_ms: 1800000  # 30min — alineado con Symphony stall_timeout
    depends_on: [setup]

  - id: finalize
    type: bash
    run: gh pr create ...
    depends_on: [agent]
```

### 5.2 Tools disponibles para el agente

Implementadas como MCP tools (o hono routes con auth) que el agente llama desde dentro del workflow:

- `update_thread_status(thread_id, status)` — pega a `PATCH /api/threads/:id`
- `update_thread_stage(thread_id, stage)` — kanban transition
- `post_thread_comment(thread_id, text)` — agrega message tipo `assistant_note`
- `link_pr(thread_id, pr_url)` — guarda en `thread.metadata.pr_url`

**Auth:** el agente usa la sesión del user dueño del thread (Better Auth cookie o token derivado). Multi-tenant safe.

### 5.3 Aislamiento de runner (CLAUDE.md)

> Routing a request to another user's runner would leak data across tenant boundaries.

El orchestrator agrupa **siempre** por `user_id`. La eligibility query lo filtra. El dispatcher pasa el `user_id` a Archon que selecciona el runner correspondiente. Si el runner del user no está disponible → marcar retry, **no fallback a otro runner**.

---

## 6. Eventos y observabilidad

Reusar `ws-broker.ts` (no construir nada nuevo). Eventos:

| Evento | Payload |
|---|---|
| `orchestrator:tick` | `{ tickId, candidatesCount, dispatchedCount, retryCount }` |
| `thread:claimed` | `{ threadId, userId, attempt }` |
| `thread:dispatched` | `{ threadId, workflowRunId }` |
| `thread:retry-queued` | `{ threadId, attempt, dueAtMs, error }` |
| `thread:stalled` | `{ threadId, lastEventAt }` |
| `thread:released` | `{ threadId, terminalStatus }` |

UI: panel "Orchestrator" en `/settings` con métricas live (slots usados, retry queue, último tick).

---

## 7. Configuración

```ts
// packages/shared/src/types/orchestrator-config.ts
export interface OrchestratorConfig {
  enabled: boolean;
  pollIntervalMs: number;        // default 5000
  reconcileIntervalMs: number;   // default 30000
  maxConcurrentGlobal: number;   // default 16
  maxConcurrentPerUser: number;  // default 4
  maxRetryBackoffMs: number;     // default 300000 (5min)
  stallTimeoutMs: number;        // default 1800000 (30min)
  workflowFile: string;          // default ".archon/workflows/symphony-thread.yaml"
}
```

Persistido en `~/.funny/orchestrator-config.json` (igual patrón que `auth-secret`). Editable desde `/settings/orchestrator` (admin only).

---

## 8. Sequencia de build (fases)

### Fase 0 — Base (medio día)
- [ ] Instalar Archon como dep (`packages/runtime` o nuevo `packages/orchestrator-bridge`).
- [ ] Decidir si se forkea Archon o se usa as-is con un wrapper. **Default: as-is** + thin adapter.
- [ ] Smoke test: ejecutar un workflow Archon mínimo desde código, sin orchestrator.

### Fase 1 — Schema + repos (1 día)
- [ ] Migrar `orchestrator_runs` y `thread_dependencies` (raw SQL en `db/migrate.ts`, convención del proyecto).
- [ ] Implementar `OrchestratorRunRepository` con `Result<T,E>`.
- [ ] Tests de repo (smoke con SQLite in-memory).

### Fase 2 — Pure logic core (1-2 días)
- [ ] `packages/core/src/orchestrator/`: `types.ts`, `eligibility.ts`, `priority.ts`, `backoff.ts`, `stall.ts`, `plan-dispatch.ts`.
- [ ] Tests unitarios exhaustivos (eligibility con todos los casos de la tabla §3.2, backoff math, stall edge cases).
- [ ] **Sin DB, sin HTTP, sin async** — todo síncrono y puro.

### Fase 3 — Service singleton (2-3 días)
- [ ] `OrchestratorService` con `start/stop/refresh/tick`.
- [ ] Wire del WS broker para eventos.
- [ ] Reconcile loop separado del poll loop.
- [ ] Test de integración con DB real: crear thread, esperar tick, verificar dispatch.

### Fase 4 — Archon dispatcher (2 días)
- [ ] `archon-dispatcher.ts` que invoca `executeWorkflow()` con `issueContext` (Archon ya lo soporta — `executor.ts:225`).
- [ ] Wire `last_event_at_ms` a los eventos del workflow run de Archon.
- [ ] Manejo de errores: workflow fail → orchestrator retry; workflow success → orchestrator release.

### Fase 5 — Tools + workflow YAML (1-2 días)
- [ ] Endpoints `PATCH /api/threads/:id/status`, `/stage`, `/comments`, `/pr`.
- [ ] Auth derivado de la sesión del thread.
- [ ] Workflow `symphony-thread.yaml` template.
- [ ] Prompt template `agent.md` con instrucciones para usar las tools.

### Fase 6 — UI mínima (1-2 días)
- [ ] Panel `/settings/orchestrator`: métricas live, toggle enabled/disabled, config.
- [ ] Indicador en kanban: cuando un thread es "claimed" por el orchestrator (badge "queued by orchestrator").
- [ ] Tests E2E con Playwright (CLAUDE.md: `data-testid` mandatorio).

### Fase 7 — Hardening (1 semana)
- [ ] Recovery post-restart del server (cargar `orchestrator_runs`, reconciliar con Archon).
- [ ] Métricas Prometheus o logs estructurados según la convención del proyecto.
- [ ] Tests de regresión: cada bug de la fase debe quedar como test (CLAUDE.md "Bug Fixes & Regression Tests").

**Total estimado:** 2-3 semanas dev, ~1000-1200 LOC nuevas (sin tests).

---

## 9. Decisiones pendientes

1. **Fork Archon o usar as-is?** Default: as-is + adapter thin. Ventaja: updates upstream. Riesgo: si Archon cambia API.
2. **Tabla `thread_dependencies` en v1 o diferida?** Recomiendo diferir — la primera versión puede asumir `blocked_by = []` para todos.
3. **Slots por user vs global** — empezar con global (`maxConcurrentGlobal`), agregar per-user en v2 cuando haya >1 user activo.
4. **Multi-runner** — ¿el orchestrator coordina N runners (como `runner-manager`) o asume 1 runner por user? Actual: 1 runner por user. Mantener.
5. **`thread.archived` vs `stage='archived'`** — redundancia existente. Resolver fuera de scope, pero el orchestrator debe respetar AMBOS como "ignorar".
6. **`thread.priority`** — campo no existe hoy en el schema (revisar). Si no existe, usar `created_at` como tiebreaker único en v1, agregar `priority INTEGER` en v2.

---

## 10. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `thread_id` re-attachable de Symphony §8 no existe en Archon | Pérdida de contexto entre retries | Aceptar divergencia: usar `loop` node con `fresh_context: false` y persistir `conversation_id` por workflow run. Documentar. |
| Race en `setting_up` entre orchestrator y user manual start | Doble dispatch del agente | Lock optimista: `UPDATE threads SET status='setting_up' WHERE id=? AND status='pending'` — verificar `affected_rows=1`. |
| Server restart mid-run | Estados huérfanos en `orchestrator_runs` | Reconcile inicial al startup: cargar todos los runs activos, query Archon, marcar para retry los que no existen. |
| Archon API cambia | Build break | Pin version exacta, integration test en CI. |
| Stall en el propio orchestrator (no detectado) | Threads no avanzan | Heartbeat: `orchestrator:tick` cada N segs visible en UI; alerta si >2× pollInterval sin tick. |
| Tool calls del agente sin auth correcta | Cross-tenant leak | Auth obligatoria en tools, con `user_id` derivado de la sesión del thread (no del request). |

---

## 11. Tests críticos (mínimos para shipear)

- [ ] Eligibility: thread en `done` no se selecciona; thread con `blocked_by` no resuelto no se selecciona.
- [ ] Slots: dispatch nunca excede `maxConcurrentGlobal`.
- [ ] Backoff: attempt=1 → 10s; attempt=10 → max cap.
- [ ] Stall: workflow sin eventos durante `stallTimeoutMs` → kill + retry.
- [ ] Reconcile: thread `running` en funny + Archon dice `failed` → re-queue.
- [ ] Multi-tenant: thread del user A NUNCA dispatchea en runner del user B.
- [ ] Restart: server reinicia con runs activos → reconciliados correctamente.

---

## 12. Referencias

- [Symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) — secciones §3, §6.2, §7-§9, §10, §13.
- [Archon — packages/workflows/](https://github.com/coleam00/Archon/tree/dev/packages/workflows) — executor, retry schema, idle timeout.
- `packages/shared/src/primitives.ts:15-25` — `ThreadStatus` y `ThreadStage`.
- `packages/shared/src/db/schema.sqlite.ts` — schema actual.
- `CLAUDE.md` — Runner Isolation, neverthrow scope, UI rules.

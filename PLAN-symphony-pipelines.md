# PLAN — Symphony sobre funny + @funny/pipelines

**Estado:** Borrador v1 (2026-05-09)
**Reemplaza:** la integración con Archon descrita en `PLAN-symphony.md`.
**Alcance:** Implementar la semántica de orquestación de [OpenAI Symphony](https://github.com/openai/symphony/blob/main/SPEC.md) usando `funny` como tracker (en lugar de Linear) y **`@funny/pipelines`** (paquete in-house, ya wired en `runtime`) como executor de workflows.

---

## 1. Por qué este plan reemplaza al anterior

El plan original asumía Archon como ejecutor externo. Revisando el monorepo confirmé que `packages/pipelines` ya cubre el rol de Archon **dentro del propio funny**:

- DAG/secuencia de nodes con guards, loops `until`, sub-pipelines y composición (`engine.ts`).
- Per-node retry con `maxAttempts`, `delayMs`, `shouldRetry`, `beforeRetry` (`engine.ts:31-58`).
- `AbortSignal` propagado a cada `NodeFn` → cancelación + base para stall detection.
- YAML con schema Zod estricto (`yaml/schema.ts`), naming snake_case (comentario explícito: *"Field naming follows snake_case to match Archon conventions"*).
- `ActionProvider` ya implementado en `runtime` como `RuntimeActionProvider` con acciones de agente, git, command, PR, notify, approval (`runtime/src/services/pipeline-adapter.ts`).
- Persistencia + UI: `pipeline-repository.ts`, `pipeline-store.ts`, panel ya visible en cliente.

**Consecuencia:** desaparece la integración con un repo externo (riesgo de licencia, drift de API, build extra). El plan se simplifica de tres procesos a un singleton + ejecutor in-process.

---

## 2. Arquitectura — dos capas (en lugar de tres)

```
┌──────────────────────────────────────────────────────────────┐
│ funny — tracker + UI + auth + DB                             │
│  threads(stage, status, ...)  ←─ "kanban" = la fuente        │
│  ws-broker emite thread:stage-changed                        │
│  repos en packages/shared/repositories                       │
└───────────────┬──────────────────────────────────────────────┘
                │ events / repo reads
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Orchestrator (NUEVO — packages/core/src/orchestrator/)       │
│  poll loop + reconcile tick (§9.5)                           │
│  eligibility query (§7.4)                                    │
│  slot manager (max_concurrent_agents global y por user)      │
│  retry scheduler con backoff exponencial (§9.3)              │
│  stall detector (§9.4) — observa eventos del run             │
│  dispatcher → runPipeline()                                  │
│  Pure logic, neverthrow Result<T,E>                          │
└───────────────┬──────────────────────────────────────────────┘
                │ runPipeline(symphony-thread, ctx, { provider })
                ▼
┌──────────────────────────────────────────────────────────────┐
│ @funny/pipelines (executor in-process)                       │
│  engine.ts — DAG, retry, loops, AbortSignal                  │
│  yaml-loader.ts — carga .funny/pipelines/*.yaml              │
│  RuntimeActionProvider (runtime) — agent/git/cmd/pr/notify   │
│  ProgressReporter → ws-broker (ya wired)                     │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Por qué dos capas

Lo que el orchestrator agrega y `@funny/pipelines` no tiene:

- **Slot cap global y por user** (§7.3) — pipelines ejecuta a demanda, sin cola.
- **Backoff/retry por issue** (§9.3) — el retry de pipelines es per-node; el de Symphony es per-issue con reuso de workspace.
- **Reconcile** (§9.5) — divergencia entre `thread.status` y el run real.
- **Priority sort** (§7.5) — cuando hay más demanda que slots.
- **Stall detection a nivel issue** — `AbortSignal` está, pero falta el timer que decide cuándo abortar.

Esas cinco cosas **son** Symphony. Sin ellas tendríamos pipelines + un trigger, no orquestación.

---

## 3. Modelo de datos (idéntico al plan anterior)

Confirmado en `packages/shared/src/primitives.ts:15-25`:

```ts
type ThreadStatus = 'setting_up' | 'idle' | 'pending' | 'running'
                  | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
type ThreadStage  = 'backlog' | 'planning' | 'in_progress' | 'review' | 'done' | 'archived';
```

| Estado interno Symphony | Predicado SQL en funny |
|---|---|
| `Unclaimed` | `stage IN ('backlog','planning','in_progress') AND status NOT IN ('running','setting_up')` |
| `Claimed` | `status='setting_up'` |
| `Running` | `status='running'` |
| `RetryQueued` | `status='waiting'` |
| `Released` | `status IN ('completed','failed','stopped','interrupted')` |
| Issue terminal en tracker | `stage IN ('done','archived')` |

**Cero columnas nuevas en `threads`.**

### 3.1 Tablas nuevas

```sql
CREATE TABLE thread_dependencies (
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  blocked_by  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, blocked_by)
);

CREATE TABLE orchestrator_runs (
  thread_id          TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  pipeline_run_id    TEXT,                 -- FK lógica al pipeline-repository
  attempt            INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms   INTEGER,
  last_event_at_ms   INTEGER NOT NULL,     -- alimenta stall detection
  last_error         TEXT,
  claimed_at_ms      INTEGER NOT NULL,
  user_id            TEXT NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);
CREATE INDEX idx_orch_runs_user  ON orchestrator_runs(user_id);
CREATE INDEX idx_orch_runs_retry ON orchestrator_runs(next_retry_at_ms)
  WHERE next_retry_at_ms IS NOT NULL;
```

**Nota:** `pipeline_run_id` reemplaza al `workflow_run_id` del plan anterior. Apunta al run persistido por `pipeline-repository.ts`.

---

## 4. Diseño del Orchestrator

### 4.1 Ubicación

| Capa | Paquete | Por qué |
|---|---|---|
| Pure logic | `packages/core/src/orchestrator/` | CLAUDE.md exige `Result<T,E>` en core |
| Singleton + lifecycle | `packages/server/src/services/orchestrator-service.ts` | Server es dueño de la DB |
| Repo SQL | `packages/shared/src/repositories/orchestrator-run-repository.ts` | Convención existente |
| **Bridge a pipelines** | `packages/runtime/src/services/orchestrator-dispatcher.ts` | El runtime ya tiene wired `RuntimeActionProvider` y la persistencia |

### 4.2 Interfaces principales

```ts
// packages/core/src/orchestrator/types.ts
import type { Result } from 'neverthrow';
import type { Thread } from '@funny/shared';

export interface SlotPolicy {
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
}

export interface EligibilityInput {
  candidates: Thread[];
  running: Map<string, RunRef>;
  claimed: Set<string>;
  retryQueue: Map<string, RetryEntry>;
  dependencies: Map<string, string[]>;
  slots: SlotPolicy;
  now: number;
}

export interface DispatchPlan {
  toDispatch: Thread[];   // priority+created_at sort aplicado
  toRetry:    Thread[];   // retry due
  toReconcile: Thread[];  // estado divergente
}

export function planDispatch(input: EligibilityInput): Result<DispatchPlan, OrchestratorError>;
export function nextRetryDelayMs(attempt: number, max: number): number;
export function isStalled(run: RunRef, stallTimeoutMs: number, now: number): boolean;
```

```ts
// packages/server/src/services/orchestrator-service.ts
export class OrchestratorService {
  private running    = new Map<string, RunRef>();
  private claimed    = new Set<string>();
  private retryQueue = new Map<string, RetryEntry>();

  start(): void;
  stop(): Promise<void>;     // grace shutdown — no mata runs en curso
  refresh(): Promise<void>;  // POST /api/orchestrator/refresh

  private async tick(): Promise<void> {
    // 1. reconcile (cargar orchestrator_runs + threads del DB)
    // 2. fetch candidates (eligibility query)
    // 3. planDispatch (pure logic)
    // 4. para cada toDispatch → dispatcher.run(thread)
    // 5. emit WS: orchestrator:tick, thread:claimed, thread:dispatched
  }
}
```

### 4.3 Eligibility query (§7.4)

```sql
SELECT t.* FROM threads t
WHERE t.user_id = ?
  AND t.stage IN ('backlog','planning','in_progress')
  AND t.status NOT IN ('running','setting_up','completed')
  AND NOT EXISTS (SELECT 1 FROM orchestrator_runs r WHERE r.thread_id = t.id)
  AND NOT EXISTS (
    SELECT 1 FROM thread_dependencies d
    JOIN threads bt ON bt.id = d.blocked_by
    WHERE d.thread_id = t.id AND bt.stage NOT IN ('done','archived')
  )
ORDER BY t.priority ASC NULLS LAST, t.created_at ASC, t.id ASC
LIMIT ?;
```

### 4.4 Backoff (§9.3)

```ts
export function nextRetryDelayMs(attempt: number, maxMs = 300_000): number {
  if (attempt <= 0) return 1_000;       // continuation post-clean
  return Math.min(10_000 * 2 ** (attempt - 1), maxMs);
}
```

### 4.5 Stall detection (§9.4) — implementación nueva

`@funny/pipelines` no incluye un equivalente al `STEP_IDLE_TIMEOUT_MS` de Archon. Se construye desde el orchestrator:

1. Cada vez que el `ProgressReporter` del run emite `onStepProgress` o `onPipelineEvent`, actualizar `orchestrator_runs.last_event_at_ms` (vía adapter del reporter en el dispatcher).
2. En cada `tick()`, evaluar `isStalled(run, stallTimeoutMs, now)`.
3. Si stalled → `abortController.abort()` (el `AbortSignal` ya está propagado al engine, los nodes lo respetan).
4. Marcar entry para retry con `attempt += 1`.

```ts
// packages/runtime/src/services/orchestrator-dispatcher.ts
const adapter: ProgressReporter = {
  onStepProgress: (id, data) => {
    runRepo.touchLastEvent(threadId, Date.now());
    wsBroker.broadcast(userId, 'pipeline:stage_update', { threadId, id, data });
  },
  onPipelineEvent: (event, data) => {
    runRepo.touchLastEvent(threadId, Date.now());
    wsBroker.broadcast(userId, `pipeline:${event}`, { threadId, ...data });
  },
};
```

### 4.6 Reconcile tick (§9.5)

Cada 30s:

1. Para cada `orchestrator_runs` activo: si `pipeline-repository` reporta `failed`/`cancelled` pero funny dice `running` → reset `status='waiting'` y schedule retry.
2. Para cada `thread.stage IN ('done','archived')` con `orchestrator_runs` vivo → `abort()` + limpiar entry.
3. Post-restart del server: cargar todos los runs activos, y si el AbortController/proceso ya no existe en memoria → marcar para retry (el run anterior se considera huérfano).

---

## 5. Integración con `@funny/pipelines`

### 5.1 Dispatcher (núcleo del bridge)

```ts
// packages/runtime/src/services/orchestrator-dispatcher.ts
import { runPipeline, loadPipelines } from '@funny/pipelines';
import { RuntimeActionProvider } from './pipeline-adapter';

export class OrchestratorDispatcher {
  async run(thread: Thread): Promise<Result<RunRef, DispatchError>> {
    const pipelineDef = await loadPipelines(thread.projectPath, 'symphony-thread');
    if (pipelineDef.isErr()) return err(/* ... */);

    const ctx = {
      threadId: thread.id,
      userId:   thread.userId,
      prompt:   thread.prompt,
      branch:   thread.branchName,
      mode:     thread.mode,             // 'local' | 'worktree'
      worktreePath: thread.worktreePath,
    };

    const provider = new RuntimeActionProvider({ userId: thread.userId, threadId: thread.id });
    const abortController = new AbortController();
    const reporter = this.makeReporter(thread);

    // disparar en background — el orchestrator track el AbortController
    const promise = runPipeline(pipelineDef.value, ctx, {
      signal: abortController.signal,
      onStateChange: change => reporter.onStepProgress(change.nodeName, {
        status: mapStatus(change.kind),
        error: change.error,
      }),
      provider,                          // si la API lo expone; si no, inyectado en ctx
    });

    return ok({ threadId: thread.id, abortController, startedAt: Date.now(), promise });
  }
}
```

### 5.2 Workflow YAML — `.funny/pipelines/symphony-thread.yaml`

Vive en cada repo del usuario. Mínimo:

```yaml
name: symphony-thread
inputs:
  - thread_id
  - prompt
  - branch
  - mode

nodes:
  - id: setup
    spawn_agent:
      provider: shell
      command: git worktree add -b {{ branch }} ../{{ thread_id }}
    when: '{{ mode == "worktree" }}'

  - id: agent
    spawn_agent:
      provider: claude
      model: sonnet
      prompt: '{{ prompt }}'
      tools: [update_thread_status, update_thread_stage,
              post_thread_comment, link_pr]
    retry:
      max_attempts: 3
      delay_ms: 2000
    depends_on: [setup]

  - id: finalize
    git_commit:
      message: 'chore: symphony run for {{ thread_id }}'
    depends_on: [agent]
```

(Schema definitivo en `packages/pipelines/src/yaml/schema.ts`.)

### 5.3 Tools disponibles para el agente

Endpoints existentes/nuevos en `packages/server`:

- `PATCH /api/threads/:id/status` — `update_thread_status`
- `PATCH /api/threads/:id/stage` — `update_thread_stage` (kanban transition)
- `POST  /api/threads/:id/comments` — `post_thread_comment`
- `PATCH /api/threads/:id/metadata` — `link_pr`

**Auth:** sesión del user dueño del thread (Better Auth cookie, o token derivado en server-side fetch). Multi-tenant safe: `user_id` derivado de la sesión del thread, no del header del request.

### 5.4 Aislamiento de runner (CLAUDE.md)

El orchestrator agrupa **siempre** por `user_id`. Eligibility query lo filtra. El dispatcher usa el `RuntimeActionProvider` ya scopeado al runner del user. Si el runner del user no está disponible → marcar retry, **sin fallback a otro runner**.

---

## 6. Eventos y observabilidad

### 6.1 Eventos WS (live)

Reusar `ws-broker.ts`. Eventos nuevos del orchestrator:

| Evento | Payload |
|---|---|
| `orchestrator:tick` | `{ tickId, candidatesCount, dispatchedCount, retryCount }` |
| `thread:claimed` | `{ threadId, userId, attempt }` |
| `thread:dispatched` | `{ threadId, pipelineRunId }` |
| `thread:retry-queued` | `{ threadId, attempt, dueAtMs, error }` |
| `thread:stalled` | `{ threadId, lastEventAt }` |
| `thread:released` | `{ threadId, terminalStatus }` |

Eventos del pipeline (`pipeline:stage_update`, `pipeline:run_started`, etc.) ya los emite el `pipeline-manager`. El orchestrator solo agrega los suyos sin duplicar.

UI: panel `/settings/orchestrator` con métricas live + badge "queued by orchestrator" en tarjetas del kanban claimed pero sin run.

### 6.2 Comparación con Archon (qué tenemos / qué falta)

Archon implementa observabilidad en tres niveles. La cobertura actual de funny + `@funny/pipelines`:

| Nivel Archon | Equivalente actual | Gap |
|---|---|---|
| **JSONL append-only por run** (`packages/workflows/src/logger.ts` → `${logDir}/${workflowRunId}.jsonl`, eventos: `workflow_start/complete/error`, `node_start/complete/skipped/error`, `assistant`, `tool`, `validation` con `tokens`, `duration_ms`, `result`, `error`, `ts`) | `pipeline-repository` persiste runs en DB pero no archivo append-only por run | **Falta** — útil para post-mortem sin DB |
| **UI de runs** (tabla `remote_agent_workflow_runs/events`, `WorkflowProgressCard`, `WorkflowDagViewer`, `StepLogs`, token usage acumulado) | `ws-broker` + `pipeline-store` + panel pipelines del cliente | Cubre live; **falta** token usage acumulado por nodo/run |
| **Telemetría anónima** (PostHog `workflow_invoked`, opt-out `ARCHON_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1`) | No hay equivalente en funny | Fuera de scope (decisión de producto) |

### 6.3 Logging JSONL por run (deliverable nuevo)

Para cubrir el gap principal, agregar un sink JSONL al `ProgressReporter` del dispatcher. **~50-100 LOC** encima de lo que ya hace `RuntimeActionProvider` + `pipeline-manager`.

```ts
// packages/runtime/src/services/orchestrator-jsonl-logger.ts
type JsonlEvent =
  | { kind: 'pipeline_start';    runId: string; threadId: string; ts: number }
  | { kind: 'pipeline_complete'; runId: string; ts: number; durationMs: number }
  | { kind: 'pipeline_error';    runId: string; ts: number; error: string }
  | { kind: 'node_start';        runId: string; nodeId: string; ts: number }
  | { kind: 'node_complete';     runId: string; nodeId: string; ts: number; durationMs: number; tokens?: number }
  | { kind: 'node_skipped';      runId: string; nodeId: string; ts: number; reason: string }
  | { kind: 'node_error';        runId: string; nodeId: string; ts: number; error: string; attempt: number }
  | { kind: 'assistant';         runId: string; nodeId: string; ts: number; tokens?: number }
  | { kind: 'tool';              runId: string; nodeId: string; ts: number; tool: string; result: 'pass'|'fail'|'warn' };
```

- **Path:** `~/.funny/orchestrator-logs/${userId}/${pipelineRunId}.jsonl` (permisos `0600`, segregado por user — alineado con Runner Isolation).
- **Rotación:** retener N días vía cleanup job en `OrchestratorService.start()` (default 30 días, configurable).
- **Wiring:** el sink se enchufa al mismo `ProgressReporter` que `touchLastEvent` (§4.5) — un solo callback escribe a DB + WS + JSONL.
- **Token tracking:** los providers Claude/Codex ya exponen usage en eventos del agente; propagarlo al `node_complete` y al campo `assistant.tokens`. Trackear acumulado por run en memoria, persistir en `orchestrator_runs.tokens_total` (columna nueva opcional, decidir en Fase 1).
- **Eventos `node_skipped` / `validation`:** el engine emite skips vía `when` guards; capturar en el `onStateChange` del dispatcher.

### 6.4 Fases afectadas

- **Fase 1:** agregar columna opcional `tokens_total INTEGER` a `orchestrator_runs`.
- **Fase 4:** el adapter del `ProgressReporter` ahora también escribe JSONL (no solo `touchLastEvent` + WS).
- **Fase 6:** UI muestra "Token usage" + link "Download log" por run.
- **Fase 7:** cleanup job de logs viejos.

Suma ~½ día al estimado total (sigue cerrando ~2 semanas).

---

## 7. Configuración

```ts
export interface OrchestratorConfig {
  enabled: boolean;
  pollIntervalMs: number;        // default 5000
  reconcileIntervalMs: number;   // default 30000
  maxConcurrentGlobal: number;   // default 16
  maxConcurrentPerUser: number;  // default 4
  maxRetryBackoffMs: number;     // default 300000  (5min)
  stallTimeoutMs: number;        // default 1800000 (30min)
  workflowName: string;          // default "symphony-thread"
}
```

Persistido en `~/.funny/orchestrator-config.json`. Editable desde `/settings/orchestrator` (admin only).

---

## 8. Sequencia de build (fases)

### Fase 0 — Smoke test (½ día)
- [ ] Ejecutar `runPipeline()` con un YAML mínimo desde un script standalone.
- [ ] Verificar que `RuntimeActionProvider` se puede instanciar fuera de `pipeline-manager`.
- [ ] Verificar que el `ProgressReporter` recibe eventos.

### Fase 1 — Schema + repos (1 día)
- [ ] Migrar `orchestrator_runs` y `thread_dependencies` (raw SQL en `db/migrate.ts`).
- [ ] `OrchestratorRunRepository` con `Result<T,E>` (incluye `touchLastEvent`).
- [ ] Tests de repo (smoke con SQLite in-memory).

### Fase 2 — Pure logic core (1-2 días)
- [ ] `packages/core/src/orchestrator/`: `types.ts`, `eligibility.ts`, `priority.ts`, `backoff.ts`, `stall.ts`, `plan-dispatch.ts`.
- [ ] Tests unitarios exhaustivos (todos los casos de §3.2, math de backoff, edge cases de stall).
- [ ] Sin DB, sin HTTP, sin async — todo síncrono y puro.

### Fase 3 — Service singleton (2-3 días)
- [ ] `OrchestratorService` con `start/stop/refresh/tick`.
- [ ] WS broker wiring.
- [ ] Reconcile loop separado del poll loop.
- [ ] Test de integración con DB real: crear thread → tick → verificar dispatch.

### Fase 4 — Pipeline dispatcher (1 día)
- [ ] `OrchestratorDispatcher` en `packages/runtime/src/services/`.
- [ ] Adapter del `ProgressReporter` que escribe a `orchestrator_runs.last_event_at_ms`.
- [ ] Manejo de errores: pipeline fail → retry; success → release.
- [ ] **Mucho menor que la Fase 4 del plan Archon (era 2 días)** porque todo es in-process.

### Fase 5 — Tools + workflow YAML (1-2 días)
- [ ] Endpoints `PATCH /api/threads/:id/{status,stage,metadata}` y `POST /comments`.
- [ ] Auth derivado de la sesión del thread.
- [ ] Workflow `symphony-thread.yaml` template + prompt template.
- [ ] Registrar las tools en el `RuntimeActionProvider` (o vía MCP si ya existe ese path).

### Fase 6 — UI mínima (1-2 días)
- [ ] Panel `/settings/orchestrator`: métricas live, toggle, config.
- [ ] Badge en kanban: "queued by orchestrator".
- [ ] Tests E2E con Playwright (`data-testid` mandatorio por CLAUDE.md).

### Fase 7 — Hardening (1 semana)
- [ ] Recovery post-restart del server (cargar `orchestrator_runs`, reconciliar).
- [ ] Logs estructurados según convención del proyecto.
- [ ] Tests de regresión (CLAUDE.md "Bug Fixes & Regression Tests").

**Total estimado:** ~2 semanas dev, **~700-900 LOC** nuevas (sin tests).
Reducción ~25% vs plan Archon, principalmente por desaparición del bridge externo.

---

## 9. Decisiones pendientes

1. **`thread_dependencies` en v1 o diferida?** Recomiendo diferir — v1 asume `blocked_by = []`.
2. **Slots por user vs global** — empezar con global, agregar per-user en v2.
3. **`thread.priority`** — campo no existe en schema actual (verificar). Si no existe, usar `created_at` como tiebreaker; agregar `priority INTEGER` en v2.
4. **`thread.archived` vs `stage='archived'`** — redundancia existente, fuera de scope; el orchestrator debe respetar AMBOS como "ignorar".
5. **`@funny/pipelines` necesita extensión?** — Sí: agregar `idle_timeout_ms` opcional al schema YAML (no implementado en engine, lo maneja el orchestrator). Trivial.
6. **Tools como MCP o HTTP directo?** — Si ya hay infra MCP en `runtime`, MCP. Si no, HTTP con auth derivada. Ambos compatibles con `RuntimeActionProvider`.

---

## 10. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Race en `setting_up` (orchestrator vs user manual start) | Doble dispatch | Lock optimista: `UPDATE threads SET status='setting_up' WHERE id=? AND status='pending'` y verificar `affected_rows=1` |
| Server restart mid-run | Estados huérfanos | Reconcile inicial: cargar runs activos, si no hay AbortController vivo en memoria → retry |
| `thread_id` re-attachable de Symphony §8 | Pérdida de contexto entre retries | Aceptar divergencia: persistir `conversation_id` por run; usar loops del engine si se necesita continuación lineal |
| Stall en el propio orchestrator | Threads no avanzan | Heartbeat: `orchestrator:tick` cada N segs; alerta si >2× pollInterval sin tick |
| Tool calls sin auth correcta | Cross-tenant leak | `user_id` derivado de la sesión del thread, no del request |
| Pipelines schema cambia con breaking change | Build break | Pipelines está in-house: cambios coordinados, tests E2E en CI |
| Dependencia circular `core ↔ runtime` | Build break | Orchestrator core no importa de runtime; runtime importa core (dirección actual ya correcta) |

---

## 11. Tests críticos (mínimos para shipear)

- [ ] Eligibility: thread en `done` no se selecciona; thread con `blocked_by` no resuelto no se selecciona.
- [ ] Slots: dispatch nunca excede `maxConcurrentGlobal`.
- [ ] Backoff: attempt=1 → 10s; attempt=10 → max cap.
- [ ] Stall: pipeline sin eventos durante `stallTimeoutMs` → `abort()` + retry.
- [ ] Reconcile: thread `running` en funny + pipeline `failed` → re-queue.
- [ ] Multi-tenant: thread del user A NUNCA dispatchea en runner del user B.
- [ ] Restart: server reinicia con runs activos → reconciliados correctamente.
- [ ] Cancelación user-initiated: arrastrar thread a `archived` mientras corre → `abort()` propagado.

---

## 12. Diferencias concretas vs `PLAN-symphony.md`

| Sección | Plan Archon | Plan Pipelines |
|---|---|---|
| §2 Capas | 3 (funny + orch + Archon) | 2 (funny + orch + pipelines in-process) |
| §3 Tabla `orchestrator_runs.workflow_run_id` | apunta a Archon | renombrado a `pipeline_run_id`, apunta a `pipeline-repository` |
| §4.5 Stall | reusar `withIdleTimeout()` de Archon | construido desde orch + `AbortSignal` (engine ya lo soporta) |
| §5 Integración | `executeWorkflow()` de Archon (fork o adapter) | `runPipeline()` in-process + `RuntimeActionProvider` |
| §5.1 Workflow path | `.archon/workflows/*.yaml` | `.funny/pipelines/*.yaml` (convención existente) |
| §8 Fase 0 | smoke test de Archon CLI | smoke test de `runPipeline()` |
| §8 Fase 4 | "Archon dispatcher" — 2 días | "Pipeline dispatcher" — 1 día (in-process) |
| §9 Decisiones | "fork Archon o usar as-is?" | "extender schema YAML con idle_timeout_ms?" |
| §10 Riesgos | drift de API Archon, licencia | dependencia circular core/runtime, schema pipelines breaking |
| Total LOC | ~1000-1200 | ~700-900 |
| Total tiempo | 2-3 semanas | ~2 semanas |

---

## 13. Referencias

- [Symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) — §3, §6.2, §7-§9, §10, §13.
- `packages/pipelines/src/engine.ts` — engine, retry, loops, AbortSignal.
- `packages/pipelines/src/yaml/schema.ts` — schema YAML (ya snake_case).
- `packages/runtime/src/pipelines/types.ts` — `ActionProvider`, opts.
- `packages/runtime/src/services/pipeline-adapter.ts` — `RuntimeActionProvider`.
- `packages/runtime/src/services/pipeline-manager.ts` — lifecycle existente, modelo a seguir.
- `packages/shared/src/primitives.ts:15-25` — `ThreadStatus`, `ThreadStage`.
- `CLAUDE.md` — Runner Isolation, neverthrow scope, UI rules.
- `PLAN-symphony.md` — plan anterior (Archon), preservado para histórico.

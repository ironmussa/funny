# Plan: Standalone Orchestrator (Nivel 3)

## Objetivo

Sacar el orquestador (brain + dispatcher) a un binario separado que se conecta a funny **solo** por HTTP/WS. Funny queda como server "tonto" desde el punto de vista del orquestador: no contiene lógica de cola, prioridad, stall, retries, ni dispatch.

## No-objetivos

- No reescribir la lógica pura (`@funny/core/orchestrator`) — ya está bien aislada.
- No cambiar el contrato de pipelines YAML.
- No mover el almacenamiento (`orchestrator_runs`, `thread_dependencies`) — sigue en la DB del server. El orquestador lo accede vía HTTP.
- No romper compatibilidad: el modo in-process actual queda detrás de un flag y se elimina en una segunda fase.

## Arquitectura target

```
┌──────────────────┐    HTTP+WS    ┌──────────────────┐
│  orchestrator    │ ────────────▶ │   funny server   │
│  binary (node)   │ ◀──────────── │   (existing)     │
└──────────────────┘               └──────────────────┘
                                          │
                                   WS tunnel │
                                          ▼
                                   ┌──────────────┐
                                   │   runner(s)  │
                                   └──────────────┘
```

El orquestador:
- Lee config (URL del server, secreto, polling intervals) de env.
- Pollea el server por threads candidatos.
- Aplica `planDispatch` (lógica pura) localmente.
- Dispara trabajo llamando endpoints HTTP del server.
- Mantiene los handles en memoria (estado ya es "stateless-recoverable" via reconcile).

## Surface HTTP que faltan en el server

Hoy el `OrchestratorService` consume estas piezas en proceso. Cada una necesita un endpoint:

| Acción | Origen actual | Endpoint nuevo |
|---|---|---|
| `listEligibleCandidates` | `ThreadQueryAdapter` (SQL directo) | `GET /api/orchestrator/candidates` |
| `listTerminalThreadIds` | SQL directo | `GET /api/orchestrator/terminal-threads` |
| `getThreadById` | SQL directo | `GET /api/threads/:id` (ya existe — verificar shape) |
| `runRepo.create/update/get/listInFlight` | `OrchestratorRunRepository` | `GET/POST/PATCH /api/orchestrator/runs` |
| `dispatcher.dispatch(thread)` | `RuntimeOrchestratorDispatcher` (WS tunnel a runner) | `POST /api/orchestrator/dispatch` (server proxea al runner como hoy) |
| `emitter.emitToUser` | `relayToUser` | Server lo hace internamente cuando recibe progress/approval del orquestador (ya existe). |
| Suscripción a estado de runs (terminal events) | `inFlight.get(...).finished` Promise | `GET /api/orchestrator/events?since=...` (long-poll) **o** WS subscribe |

## Fases

### Fase 1 — Paquete `@funny/orchestrator` (sin extracción de proceso)

- Crear `packages/orchestrator/` workspace.
- Mover dispatcher puro: `OrchestratorPipelineDispatcher` → `@funny/orchestrator/dispatcher`.
- Mover interfaces puras: `PipelineLoader`, `ActionProviderFactory`, `DispatchHandle`, etc.
- Runtime y server siguen importando desde el nuevo paquete.
- **Cero cambios funcionales.** Solo reorganización.

**Salida:** typecheck + tests verdes, mismo comportamiento.

### Fase 2 — Endpoints HTTP que faltan

- `GET /api/orchestrator/candidates` — devuelve `Thread[]` elegibles.
- `GET /api/orchestrator/terminal-threads` — devuelve `string[]` (ids).
- `GET /api/orchestrator/runs?status=...` — listar runs (con filtro).
- `POST /api/orchestrator/runs` — crear run.
- `PATCH /api/orchestrator/runs/:id` — actualizar (status, lastEventAt, error, etc).
- `POST /api/orchestrator/dispatch` — server-side: recibe `{threadId, pipelineName, prompt}`, invoca al runner por tunnel, devuelve `{pipelineRunId}`. Hoy esto vive in-proc en `RuntimeOrchestratorDispatcher`.
- `GET /api/orchestrator/events?since=...` — long-poll de eventos terminales (`run_completed`, `run_failed`, `run_cancelled`). El brain remoto lo usa en lugar de la promesa `finished`.

Auth: header `X-Orchestrator-Auth` ya existe; verificar que estos endpoints lo aceptan + `X-Forwarded-User` cuando aplique (la mayoría son cross-tenant — el orquestador opera sobre todos los usuarios).

**Salida:** server expone toda la información que el brain necesita.

### Fase 3 — `HttpDispatcher` y `HttpThreadQuery`

- En `@funny/orchestrator`, crear adapters HTTP:
  - `HttpThreadQueryAdapter` implementa `ThreadQueryAdapter` haciendo fetch a los endpoints de fase 2.
  - `HttpOrchestratorRunRepository` implementa la interfaz del repo via HTTP.
  - `HttpDispatcher` implementa `Dispatcher` llamando al endpoint dispatch + escuchando eventos.
- El `OrchestratorService` se mueve a `@funny/orchestrator` (es agnóstico de transport hoy gracias a los adapters).
- Server sigue arrancando el orquestador in-proc por compatibilidad (con los adapters viejos).

**Salida:** dos modos coexisten — in-proc (legacy) y HTTP (nuevo).

### Fase 4 — Binario standalone

- `packages/orchestrator/src/bin/orchestrator.ts`:
  - Lee env (`FUNNY_SERVER_URL`, `ORCHESTRATOR_AUTH_SECRET`, intervals).
  - Construye `OrchestratorService` con adapters HTTP.
  - Registra signal handlers (SIGTERM / SIGINT) para `stop()` graceful.
  - Logging via Abbacchio (mismo transport).
- `package.json`: `bin` field, scripts `dev:orchestrator` / `start:orchestrator`.
- README + `.env.example` actualizados.
- Smoke test E2E: levantar server + runner + orchestrator binary, dispatch end-to-end.

**Salida:** orquestador como proceso separado.

### Fase 5 — Cleanup

- Quitar el wiring in-proc del server (`orchestrator-bootstrap.ts` server-side).
- Server queda con `ORCHESTRATOR_ENABLED=false` por default — debe levantarse el binario.
- Migration notes en README.

## Riesgos y mitigaciones

1. **Eventos terminales perdidos.** Long-poll vs WS. WS es más limpio pero agrega complejidad de reconexión. Voy con long-poll en fase 2 → upgrade a WS si la latencia/load lo justifica.
2. **Doble orquestador.** Si alguien arranca el server con ORCHESTRATOR_ENABLED=true y también el binario, hay dos brains compitiendo. Mitigación: lock de proceso vía DB (`instance_settings` con leader-election token + heartbeat) **o** simplemente documentar en fase 4 + sacar el wiring server en fase 5.
3. **Auth surface.** Los nuevos endpoints son cross-tenant (el orquestador ve todos los users). Hoy `X-Orchestrator-Auth` en el middleware de auth requiere `X-Forwarded-User` para impersonar. Necesitamos un modo "system" que lo permita sin user (o un user `system` reservado). Mitigación: agregar flag al middleware `allowSystem` para los endpoints de orquestador-only.
4. **Test seams.** Los tests actuales del `OrchestratorService` mockean los adapters — siguen sirviendo. Los tests del server-routes hay que reescribir con el nuevo dispatcher.
5. **YAML overrides por proyecto.** Hoy `loadPipelines()` lee `<repoRoot>/.funny/pipelines/*.yaml`. El binario standalone no tiene acceso al fs del usuario. Opciones: (a) bundlear los pipelines built-in y no soportar overrides en este modo, (b) endpoint `GET /api/pipelines/yaml?projectId=...` que devuelve YAML mergeado. Voy con (a) para fase 4, (b) si hay demanda.
6. **Tiempo de implementación realista.** 3–5 días dedicados. Cada fase es un PR separado y mergeable.

## Estimación por fase

| Fase | Estimación | Bloqueante de la siguiente |
|---|---|---|
| 1 — Paquete `@funny/orchestrator` | 2–3 hs | No (refactor puro) |
| 2 — Endpoints HTTP | 4–6 hs | Sí (fase 3 los necesita) |
| 3 — Adapters HTTP | 4–6 hs | Sí |
| 4 — Binario | 4–6 hs | Sí |
| 5 — Cleanup + migration | 2–3 hs | No (cosmético) |
| **Total** | **16–24 hs** | Spread en ~3–4 sesiones |

## Decisión pendiente del usuario

Antes de arrancar fase 1 necesito sign-off explícito en:

1. **Cross-tenant auth:** ¿OK que el orquestador opere sin `X-Forwarded-User`, vía un modo "system" en el middleware?
2. **YAML overrides:** ¿OK perder overrides por proyecto en modo standalone, o querés el endpoint `GET /api/pipelines/yaml`?
3. **Eventos terminales:** ¿Long-poll (más simple) o WS (más eficiente)?
4. **Ritmo:** ¿Hacemos las 5 fases en sesiones separadas o las encadenamos?

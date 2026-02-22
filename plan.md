# Plan: API para agentes externos — Soporte de `thread_id` directo en Ingest

## Contexto

Ya existe un sistema de ingest en `POST /api/ingest/webhook` con un `IngestMapper` completo que:
- Crea hilos vía `*.accepted` events
- Procesa mensajes CLI vía `*.cli_message` events
- Maneja ciclo de vida (`*.started`, `*.completed`, `*.failed`, `*.stopped`)
- Emite WebSocket events para actualización en tiempo real en la UI

**Problema actual:** El ingest resuelve hilos SOLO por `request_id` → `externalRequestId`. No puede enviar mensajes a un hilo existente creado desde la UI (que no tiene `externalRequestId`).

## Lo que se va a implementar

Extender el ingest API para soportar **`thread_id` directo** como alternativa a `request_id`, permitiendo enviar mensajes a cualquier hilo existente.

---

## Cambios

### 1. Ampliar `IngestEvent` — Agregar `thread_id` opcional

**Archivo:** `packages/server/src/services/ingest-mapper.ts`

```typescript
export interface IngestEvent {
  event_type: string;
  request_id: string;
  thread_id?: string;       // ← NUEVO: ID directo de hilo existente
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
```

### 2. Nueva función `getStateByThreadId()` en `ingest-mapper.ts`

Busca directamente por `tm.getThread(threadId)` y construye el `ExternalThreadState`. Cachea en `threadStates` usando `__thread:${threadId}` como key para no colisionar con request_ids.

### 3. Modificar `resolveState()` — Resolver por `thread_id` O `request_id`

Nueva función auxiliar que combina ambos paths:

```typescript
function resolveState(event: IngestEvent): ExternalThreadState | null {
  // 1. thread_id directo tiene prioridad
  if (event.thread_id) return getStateByThreadId(event.thread_id);
  // 2. Fallback a request_id (comportamiento actual)
  return getState(event.request_id);
}
```

Reemplazar todas las llamadas a `getState(event.request_id)` en `onStarted`, `onCompleted`, `onFailed`, `onStopped`, `onCLIMessage`, `onMessage` por `resolveState(event)`.

### 4. Modificar `onAccepted` — Soporte para vincular hilo existente

Cuando `thread_id` viene en el evento `*.accepted`:
- Si el hilo ya existe en DB, vincular el `request_id` al hilo existente (actualizar `externalRequestId` y `provider` a `external`)
- Si no existe, crear uno nuevo como hoy

### 5. Relajar validación en `ingest.ts`

**Archivo:** `packages/server/src/routes/ingest.ts`

Actualmente si no viene `request_id` se retorna `{ skipped: true }`. Cambiar para que si viene `thread_id`, se procese el evento aunque `request_id` esté vacío.

```typescript
// Antes:
if (!body.request_id) {
  return c.json({ status: 'ok', skipped: true }, 200);
}

// Después:
if (!body.request_id && !body.thread_id) {
  return c.json({ status: 'ok', skipped: true }, 200);
}
```

---

## Ejemplo de uso

### Enviar a un hilo existente (creado en la UI)
```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: mi-secreto" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "thread_id": "el-thread-id-de-funny",
    "request_id": "",
    "timestamp": "2026-02-22T10:00:01Z",
    "data": {
      "cli_message": {
        "type": "assistant",
        "message": {
          "id": "msg_1",
          "content": [{ "type": "text", "text": "Resultado del análisis..." }]
        }
      }
    }
  }'
```

### Crear hilo nuevo (ya funciona hoy)
```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: mi-secreto" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.accepted",
    "request_id": "run-123",
    "timestamp": "2026-02-22T10:00:00Z",
    "data": { "title": "Mi agente externo", "prompt": "Analizando..." },
    "metadata": { "projectId": "abc123" }
  }'
```

---

## Archivos a modificar

1. **`packages/server/src/services/ingest-mapper.ts`** — Agregar `thread_id` al tipo, `getStateByThreadId()`, `resolveState()`, actualizar handlers
2. **`packages/server/src/routes/ingest.ts`** — Relajar validación de `request_id`

**Total: 2 archivos modificados, 0 archivos nuevos.**

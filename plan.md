# Slack Webhook por Proyecto

## Resumen
Agregar un campo `slackWebhookUrl` a cada proyecto. Cuando un agente complete (success, failure, o stopped), enviar una notificacion a Slack via el webhook.

## Cambios

### 1. Database — `packages/server/src/db/migrate.ts`
- Nueva migracion `022_slack_webhook`:
  - `addColumn('projects', 'slack_webhook_url', 'TEXT')`

### 2. Schema — `packages/server/src/db/schema.ts`
- Agregar `slackWebhookUrl: text('slack_webhook_url')` a la tabla `projects`.

### 3. Tipos Compartidos — `packages/shared/src/types.ts`
- Agregar `slackWebhookUrl?: string` a la interfaz `Project`.

### 4. Validacion — `packages/server/src/validation/schemas.ts`
- Agregar `slackWebhookUrl` al `updateProjectSchema`: `z.string().url().nullable().optional()`

### 5. Project Manager — `packages/server/src/services/project-manager.ts`
- Agregar `slackWebhookUrl` a los campos aceptados de `updateProject`.

### 6. Slack Notifier — `packages/server/src/services/slack-notifier.ts` (archivo nuevo)
- Funcion `sendSlackNotification(webhookUrl, payload)` que hace POST con Block Kit.
- Manejo silencioso de errores (log only, nunca throw).

### 7. Suscripcion al evento — `packages/server/src/index.ts`
- Suscribirse a `threadEventBus.on('agent:completed', ...)`.
- Buscar proyecto, verificar si tiene `slackWebhookUrl`, y llamar al notifier.

### 8. UI Settings — `packages/client/src/components/SettingsDetailView.tsx`
- Nuevo `SettingRow` en la seccion Project para "Slack Webhook URL".
- Input de texto con placeholder `https://hooks.slack.com/services/...`.
- Llama `updateProject(projectId, { slackWebhookUrl: value })` on blur.

### 9. Store del cliente — `packages/client/src/stores/project-store.ts`
- Agregar `slackWebhookUrl` al tipo del parametro de `updateProject`.

### 10. API del cliente — `packages/client/src/lib/api.ts`
- Agregar `slackWebhookUrl` al tipo de update si esta tipado separadamente.

### 11. Traducciones — `packages/client/src/locales/{en,es,pt}/translation.json`
- Agregar keys: `settings.slackWebhook`, `settings.slackWebhookDesc`, `settings.slackWebhookPlaceholder`.

## Formato del mensaje de Slack
Block Kit con:
- Icono de status (check/cross/stop)
- Titulo del thread y nombre del proyecto
- Costo y status

## No-goals
- No Slack app/OAuth — solo incoming webhooks simples
- No UI para probar el webhook
- No override por thread individual

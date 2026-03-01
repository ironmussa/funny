# Plan de Pruebas E2E - Playwright

## Referencia de data-testid disponibles

### Sidebar
`sidebar-search`, `sidebar-kanban`, `sidebar-grid`, `sidebar-analytics`, `sidebar-collapse`, `sidebar-add-project`, `sidebar-no-projects-cta`, `sidebar-logout`, `sidebar-settings`, `archive-thread-cancel`, `archive-thread-confirm`, `delete-thread-cancel`, `delete-thread-confirm`, `rename-project-input`, `rename-project-cancel`, `rename-project-confirm`, `delete-project-cancel`, `delete-project-confirm`

### Project Item
`project-item-{id}`, `project-search-threads-{id}`, `project-more-actions-{id}`, `project-menu-open-directory`, `project-menu-open-terminal`, `project-menu-open-editor`, `project-menu-settings`, `project-menu-analytics`, `project-menu-github-issues`, `project-menu-rename`, `project-menu-delete`, `project-new-thread-{id}`, `project-view-all-{id}`

### Thread Item
`thread-item-{id}`, `thread-item-more-{id}`

### Project Header
`header-more-actions`, `header-menu-copy-text`, `header-menu-copy-all`, `header-menu-pin`, `header-menu-delete`, `header-delete-cancel`, `header-delete-confirm`, `header-startup-commands`, `header-stage-select`, `header-back-kanban`, `header-back-parent`, `header-view-board`, `header-preview`, `header-open-editor`, `header-toggle-terminal`, `header-toggle-review`

### New Thread Dialog
`new-thread-branch-trigger`, `new-thread-branch-search`, `new-thread-worktree-checkbox`, `new-thread-provider-select`, `new-thread-model-select`, `new-thread-title-input`, `new-thread-prompt`, `new-thread-cancel`, `new-thread-create`

### Thread View
`message-copy`, `waiting-accept`, `waiting-reject`, `waiting-response-input`, `waiting-send`, `permission-approve`, `permission-deny`, `scroll-to-bottom`

### Prompt Input
`prompt-textarea`, `prompt-file-input`, `prompt-attach`, `prompt-mode-select`, `prompt-model-select`, `prompt-stop`, `prompt-send`, `prompt-worktree-switch`, `prompt-backlog-toggle`

### Review Pane
`review-refresh`, `review-pull`, `review-commit-log`, `review-stash`, `review-discard-all`, `review-close`, `review-expand-diff`, `review-file-filter`, `review-file-filter-clear`, `review-select-all`, `review-commit-title`, `review-commit-body`, `review-generate-commit-msg`, `review-commit-execute`, `review-push`, `review-undo-commit`, `review-pop-stash`, `review-merge`, `review-create-pr`, `review-pr-title`, `review-pr-body`, `review-pr-cancel`, `review-pr-create`

### Git Progress Modal
`git-progress-pr-link`, `git-progress-done`

### Add Project View
`add-project-tab-local`, `add-project-tab-clone`, `add-project-name`, `add-project-path`, `add-project-browse`, `add-project-cancel`, `add-project-submit`, `git-init-cancel`, `git-init-confirm`

### Command Palette
`command-palette-search`, `command-palette-project-{id}`, `command-palette-settings-{id}`

### All Threads View
`all-threads-list-view`, `all-threads-board-view`, `all-threads-search`, `all-threads-clear-search`, `all-threads-project-filter`, `all-threads-sort`, `all-threads-sort-direction`, `all-threads-show-archived`, `all-threads-clear-filters`

### Kanban View
`kanban-card-{id}`, `kanban-card-pin-{id}`, `kanban-card-delete-{id}`, `kanban-add-thread`, `kanban-load-more-{stage}`, `kanban-delete-cancel`, `kanban-delete-confirm`

### Analytics View
`analytics-project-filter`, `analytics-loading`, `analytics-no-data`, `analytics-metric-cards`, `analytics-metric-{color}`, `analytics-cost-card`, `analytics-stage-chart`, `analytics-timeline-chart`, `analytics-time-range`, `analytics-time-range-{value}`, `analytics-group-by`, `analytics-group-by-{value}`

### Grid / Live Columns View
`grid-view`, `grid-add-thread`, `grid-empty-state`, `grid-active-count`, `grid-container`, `grid-column-{threadId}`

### Automation Inbox
`inbox-manage-automations`, `inbox-tab-{status}`, `inbox-search`, `inbox-project-filter`

### General Settings Dialog
`settings-dialog-theme-{value}`, `settings-dialog-editor-select`, `settings-dialog-internal-editor`, `settings-dialog-language-select`, `settings-dialog-shell-select`, `settings-dialog-github-token`, `settings-dialog-clear-token`, `settings-dialog-cancel`, `settings-dialog-save`

### Settings Panel
`settings-back`, `settings-nav-{id}`

### Settings Detail View
`project-color-none`, `settings-url-pattern-add`, `settings-reset-defaults`

---

## 1. Autenticacion y Bootstrap — `auth.spec.ts`

- [x] 1.1 App loads in local mode — La app carga sin login, muestra sidebar y area principal
- [x] 1.2 Bootstrap fetch sets auth token — `GET /api/bootstrap` devuelve token y la app lo almacena
- [ ] 1.3 Login page renders in multi mode — Con `AUTH_MODE=multi`, muestra formulario username/password
- [ ] 1.4 Login with valid credentials — Login con admin/admin redirige a la app principal
- [ ] 1.5 Login with invalid credentials — Muestra mensaje de error rojo
- [ ] 1.6 Login button disabled when fields empty — Submit deshabilitado hasta campos llenos
- [x] 1.7 Logout not shown in local mode — `sidebar-logout` no visible en modo local
- [ ] 1.8 Session persistence — Recargar pagina mantiene sesion activa (cookie)
- [x] 1.9 Auth gate shows skeleton — Durante bootstrap, muestra AppShellSkeleton

## 2. Sidebar — `sidebar.spec.ts`

- [x] 2.1 Sidebar renders with navigation icons — `sidebar-search`, `sidebar-kanban`, `sidebar-grid`, `sidebar-analytics` visibles
- [x] 2.2 Sidebar collapse/expand — Click `sidebar-collapse` colapsa; click en PanelLeft re-expande
- [ ] 2.3 Sidebar width persistence — Redimensionar guarda ancho en localStorage (`sidebar_width`)
- [x] 2.4 Navigate to /list — Click `sidebar-search` navega a `/list`
- [x] 2.5 Navigate to /kanban — Click `sidebar-kanban` navega a `/kanban`
- [x] 2.6 Navigate to /grid — Click `sidebar-grid` navega a `/grid`
- [x] 2.7 Navigate to /analytics — Click `sidebar-analytics` navega a `/analytics`
- [x] 2.8 Add project navigates to /new — Click `sidebar-add-project` navega a `/new`
- [x] 2.9 Project accordion expand/collapse — Click `project-item-{id}` expande/colapsa threads
- [x] 2.10 Project context menu - rename — `project-menu-rename` + `rename-project-input` + confirm/cancel
- [x] 2.11 Project context menu - delete — `project-menu-delete` + confirm/cancel
- [x] 2.12 Thread click navigates — Click `thread-item-{id}` navega a `/projects/:id/threads/:threadId`
- [x] 2.13 Thread context menu - archive — Via `thread-item-more-{id}`, confirm/cancel
- [ ] 2.14 Thread context menu - pin/unpin — Via `thread-item-more-{id}`, pin mueve al tope
- [x] 2.15 Thread context menu - delete — Via `thread-item-more-{id}`, confirm/cancel
- [ ] 2.16 Running threads section — Threads running aparecen en seccion superior
- [ ] 2.17 Project drag-and-drop reorder — Arrastrar `project-item-{id}` cambia posicion
- [ ] 2.18 Automation inbox button — Click navega a `/inbox`
- [x] 2.19 Settings gear icon — Click `sidebar-settings` abre GeneralSettingsDialog
- [x] 2.20 No projects CTA — `sidebar-no-projects-cta` visible cuando no hay proyectos

## 3. Gestion de Proyectos (AddProjectView) — `add-project.spec.ts`

- [x] 3.1 Local folder tab renders — `add-project-tab-local` activo, muestra `add-project-name` y `add-project-path`
- [x] 3.2 Auto-fill project name — Ingresar path en `add-project-path` auto-rellena `add-project-name`
- [ ] 3.3 Folder picker — Click `add-project-browse` abre FolderPicker
- [x] 3.4 Add project with valid git repo — Fill campos, click `add-project-submit` crea proyecto
- [x] 3.5 Add project non-git path — Muestra dialog, `git-init-confirm` ejecuta git init
- [x] 3.6 Cancel add project — `add-project-cancel` navega a `/`
- [x] 3.7 GitHub clone tab — Click `add-project-tab-clone` muestra vista de clone
- [x] 3.8 Git init cancel — `git-init-cancel` cierra dialog sin inicializar

## 4. Creacion de Threads (NewThreadDialog) — `new-thread.spec.ts`

- [x] 4.1 Dialog opens from sidebar — Click `project-new-thread-{id}` abre dialogo
- [x] 4.2 Branch picker loads branches — Click `new-thread-branch-trigger` abre popover con branches
- [x] 4.3 Branch search filter — Escribir en `new-thread-branch-search` filtra branches
- [x] 4.4 Worktree toggle — Click `new-thread-worktree-checkbox` activa/desactiva worktree
- [x] 4.5 Provider selector — `new-thread-provider-select` muestra opciones de provider
- [x] 4.6 Model selector — `new-thread-model-select` cambia con provider seleccionado
- [x] 4.7 Create disabled without prompt — `new-thread-create` deshabilitado si `new-thread-prompt` vacio
- [ ] 4.8 Create thread local mode — Fill `new-thread-prompt`, click `new-thread-create`, navega a thread
- [ ] 4.9 Create thread worktree mode — Con `new-thread-worktree-checkbox` activo, muestra `git-progress-done`
- [x] 4.10 Cancel closes dialog — `new-thread-cancel` cierra sin crear
- [x] 4.11 Optional title — `new-thread-title-input` vacio genera titulo automatico

## 5. Vista de Thread (ThreadView) — `thread-view.spec.ts`

- [x] 5.1 Empty state renders — Sin thread seleccionado muestra estado vacio
- [x] 5.2 Thread header shows metadata — ProjectHeader muestra proyecto, titulo, badges
- [x] 5.3 Navigate to thread shows content — Click thread navega y carga vista
- [x] 5.4 Assistant message with markdown — Markdown renderiza correctamente (API mock) `thread-view-messages.spec.ts`
- [x] 5.5 Code syntax highlighting — Bloques de codigo con syntax highlighting (API mock)
- [x] 5.6 Tool call cards render — ToolCallCard muestra nombre y resumen (API mock)
- [x] 5.7 Tool call card expand/collapse — Click expande/colapsa detalles (API mock)
- [ ] 5.8 Specific tool cards — BashCard, ReadFileCard, WriteFileCard, EditFileCard
- [x] 5.9 Git event cards — GitEventCard muestra commits, pushes, merges (API mock)
- [x] 5.10 Context usage bar — ContextUsageBar muestra uso de tokens (API mock)
- [x] 5.11 Scroll to bottom button — `scroll-to-bottom` testid verificado
- [ ] 5.12 Message infinite scroll — Scroll al tope carga mensajes anteriores
- [ ] 5.13 Status badges — Todos los estados se muestran correctamente
- [ ] 5.14 Image attachments render — Imagenes adjuntas inline
- [ ] 5.15 Image lightbox — Click en imagen abre lightbox con zoom
- [ ] 5.16 Compaction event card — CompactionEventCard se muestra
- [x] 5.17 Agent result card — AgentResultCard al terminar agente (API mock) `thread-view-messages.spec.ts`
- [x] 5.18 Agent stopped/interrupted cards — Cards terminales correctas (API mock)
- [x] 5.19 Waiting accept/reject — Testids verificados en DOM
- [ ] 5.20 Waiting text response — `waiting-response-input` + `waiting-send` para respuestas de texto
- [ ] 5.21 Retry failed message — Regenera la respuesta al fallar el mensaje
- [ ] 5.22 Edit message — Editar un mensaje de usuario anterior y reenviar
- [ ] 5.23 View raw source / markdown — Boton para ver el source crudo del mensaje

## 6. Input del Prompt (PromptInput) — `prompt-input.spec.ts`

- [x] 6.1 Textarea auto-expands — `prompt-textarea` crece con multiples lineas
- [x] 6.2 Send follow-up message — Escribir en `prompt-textarea` + click `prompt-send`
- [x] 6.3 Stop running agent — `prompt-stop` visible mientras agent corre (API mock) `prompt-agent-states.spec.ts`
- [x] 6.4 Model selector in prompt — `prompt-model-select` permite cambiar modelo
- [x] 6.5 Permission mode select — `prompt-mode-select` permite cambiar modo
- [x] 6.6 Image attachment — `prompt-attach` abre file picker (`prompt-file-input`)
- [x] 6.7 Send disabled when empty — `prompt-send` no clickeable sin texto en `prompt-textarea`
- [x] 6.8 Permission request dialog — `permission-approve` y `permission-deny` visibles (API mock) `prompt-agent-states.spec.ts`
- [x] 6.9 Approve tool execution — Click `permission-approve` envia aprobacion (API mock)
- [x] 6.10 Deny tool execution — Click `permission-deny` envia denegacion (API mock)
- [ ] 6.11 Worktree switch — `prompt-worktree-switch` visible en modo worktree
- [ ] 6.12 Backlog toggle — `prompt-backlog-toggle` funciona correctamente
- [ ] 6.13 Clipboard paste interaction — `Ctrl+V` pega texto o imagenes adjuntas
- [ ] 6.14 Drag and drop files — Arrastrar archivos en el dropzone añade adjuntos
- [ ] 6.15 File size limits — Muestra advertencia si el archivo supera el máximo admitido
- [ ] 6.16 Remove attachment — Click en el boton borrar o (x) descarta el archivo
- [ ] 6.17 Prompt history navigation — Teclas Flecha Arriba/Abajo navegan el historial

## 7. Review Pane (Git Operations) — `review-pane.spec.ts`

- [x] 7.1 Toggle review pane — Click `header-toggle-review` abre/cierra panel
- [x] 7.2 Close review pane — `review-close` cierra el panel
- [x] 7.3 Diff summary loads — Lista archivos con cambios se carga
- [ ] 7.4 File click shows diff — Click en archivo muestra diff inline
- [ ] 7.5 Full-screen diff — Click `review-expand-diff` abre diff full-screen
- [x] 7.6 File search filter — `review-file-filter` filtra archivos, `review-file-filter-clear` limpia
- [x] 7.7 Select all checkbox — `review-select-all` selecciona/deselecciona todos
- [ ] 7.8 File status badges — Badges A/M/D/R se muestran
- [x] 7.9 Commit title and body — `review-commit-title` y `review-commit-body` inputs
- [ ] 7.10 AI generate commit message — `review-generate-commit-msg` genera mensaje via API
- [x] 7.11 Commit action — `review-commit-execute` realiza stage + commit
- [ ] 7.12 Push action — `review-push` ejecuta push
- [ ] 7.13 Undo last commit — `review-undo-commit` ejecuta reset soft
- [ ] 7.14 Pop stash — `review-pop-stash` restaura stash
- [ ] 7.15 Merge (worktree) — `review-merge` ejecuta merge a branch base
- [x] 7.16 Create PR dialog — `review-create-pr` abre dialog con `review-pr-title`, `review-pr-body`
- [x] 7.17 PR dialog cancel — `review-pr-cancel` cierra dialog
- [ ] 7.18 PR dialog submit — `review-pr-create` crea PR
- [x] 7.19 Git progress modal done — `git-progress-done` cierra modal
- [x] 7.20 Refresh button — `review-refresh` recarga diff summary
- [ ] 7.21 Pull button — `review-pull` ejecuta pull
- [x] 7.22 Commit log popover — `review-commit-log` muestra ultimos 20 commits
- [ ] 7.23 Stash button — `review-stash` ejecuta stash
- [x] 7.24 Discard all — `review-discard-all` abre confirmacion descarte total
- [ ] 7.25 Diff syntax highlighting — Diferencias de lineas mostradas con color rojo/verde
- [ ] 7.26 Stage individual changes/hunks — Soporte para descartar/stager partes (si aplica)
- [ ] 7.27 Merge conflicts UI — Modo específico o advertencias si existen conflictos
- [ ] 7.28 Fetch / Sync button — Actualiza el status contra el remoto de manera forzada

## 8. Settings — `settings.spec.ts`

- [x] 8.1 Settings navigation — `settings-back` vuelve, `settings-nav-{id}` navega a seccion
- [x] 8.2 General - project color — `project-color-none` y color pickers
- [ ] 8.3 General - follow-up mode — Segmented control via testId en opciones
- [ ] 8.4 General - default model — Combobox provider + model
- [ ] 8.5 General - thread mode — Segmented control: local/worktree
- [ ] 8.6 General - permission mode — Segmented control: ask/plan/autoEdit/confirmEdit
- [x] 8.7 General - extension URLs — `settings-url-pattern-add` agrega URLs
- [ ] 8.8 General - tool permissions — Per-tool allow/ask/deny controls
- [x] 8.9 General - reset defaults — `settings-reset-defaults` restaura permisos
- [ ] 8.10 MCP - list servers — Lista servers existentes
- [ ] 8.11 MCP - add server — Formulario name, type, command, env
- [ ] 8.12 MCP - remove server — Delete elimina server
- [ ] 8.13 MCP - recommended servers — Seccion recomendados
- [ ] 8.14 Skills - list — Lista skills instalados
- [ ] 8.15 Skills - add/remove — Add por identifier, remove
- [ ] 8.16 Worktrees - list — Lista worktrees del proyecto
- [ ] 8.17 Worktrees - remove — Delete limpia worktree
- [ ] 8.18 Startup commands - CRUD — Add, edit, delete comandos
- [ ] 8.19 Startup commands - run/stop — Ejecutar y detener
- [ ] 8.20 Automations - CRUD — Create, edit, delete automaciones
- [ ] 8.21 Automations - enable/disable — Toggle habilita/deshabilita
- [ ] 8.22 Automations - trigger now — Dispara ejecucion manual
- [ ] 8.23 Automations - run history — Ver historial ejecuciones
- [ ] 8.24 Archived threads - list — Lista paginada con busqueda
- [ ] 8.25 Archived threads - unarchive — Restaura thread
- [ ] 8.26 Archived threads - delete — Elimina permanentemente
- [ ] 8.27 Users - list (admin multi) — Lista usuarios
- [ ] 8.28 Users - create — Crear usuario con datos completos
- [ ] 8.29 Users - edit — Editar nombre, rol, password
- [ ] 8.30 Users - delete — Eliminar con confirmacion

## 9. General Settings Dialog (Modal) — `settings.spec.ts`

- [x] 9.1 Theme selection — `settings-dialog-theme-{light|dark|system}` se aplica y persiste
- [x] 9.2 Default editor — `settings-dialog-editor-select` se guarda
- [x] 9.3 Internal editor toggle — `settings-dialog-internal-editor` activa/desactiva
- [x] 9.4 Language selection — `settings-dialog-language-select` cambia idioma
- [x] 9.5 Terminal shell — `settings-dialog-shell-select` seleccion de shell
- [ ] 9.6 GitHub token — `settings-dialog-github-token`, `settings-dialog-clear-token`
- [x] 9.7 Cancel — `settings-dialog-cancel` descarta cambios
- [x] 9.8 Save — `settings-dialog-save` persiste cambios

## 10. All Threads View — `all-threads.spec.ts`

- [x] 10.1 List view renders — `all-threads-list-view` activo, tabla con threads
- [x] 10.2 Board view renders — `all-threads-board-view` cambia a kanban
- [x] 10.3 Full-text search — `all-threads-search` busca, `all-threads-clear-search` limpia
- [x] 10.4 Project filter — `all-threads-project-filter` filtra por proyecto
- [x] 10.5 Sort toggle — `all-threads-sort` cambia criterio de orden
- [x] 10.6 Sort direction — `all-threads-sort-direction` invierte orden
- [x] 10.7 Show archived — `all-threads-show-archived` muestra/oculta archivados
- [x] 10.8 Clear filters — `all-threads-clear-filters` restaura filtros
- [ ] 10.9 Click thread navigates — Click en row navega al thread
- [x] 10.10 Tab switch list/board — `all-threads-list-view` y `all-threads-board-view` alternan

## 11. Kanban View — `kanban.spec.ts`

- [x] 11.1 Kanban cards render — `kanban-card-{id}` visibles en columnas
- [x] 11.2 Kanban card pin — `kanban-card-pin-{id}` fija thread
- [x] 11.3 Kanban card delete — `kanban-card-delete-{id}` con `kanban-delete-confirm`/`kanban-delete-cancel`
- [x] 11.4 Add thread from kanban — `kanban-add-thread` inicia nuevo thread
- [ ] 11.5 Load more — `kanban-load-more-{stage}` carga mas cards
- [ ] 11.6 Drag-and-drop — Arrastrar card entre columnas actualiza stage
- [ ] 11.7 Hover states — Tarjetas muestran sombra o borde interactivo on hover
- [ ] 11.8 Navigate from board — Click en la card navega hacia la vista de Thread

## 12. Command Palette — `command-palette.spec.ts`

- [x] 12.1 Ctrl+K opens palette — Shortcut abre dialog con `command-palette-search`
- [x] 12.2 Search filters results — Escribir en `command-palette-search` filtra
- [x] 12.3 Click project — `command-palette-project-{id}` inicia nuevo thread
- [x] 12.4 Click settings — `command-palette-settings-{id}` navega a pagina
- [x] 12.5 Escape closes palette — Esc cierra el dialog

## 13. Project Header Actions — `project-header.spec.ts`

- [x] 13.1 More actions menu — `header-more-actions` abre dropdown
- [x] 13.2 Copy text — `header-menu-copy-text` copia ultimo mensaje
- [x] 13.3 Copy all — `header-menu-copy-all` copia conversacion completa
- [x] 13.4 Pin thread — `header-menu-pin` fija/desfija thread
- [x] 13.5 Delete thread — `header-menu-delete` con `header-delete-confirm`/`header-delete-cancel`
- [x] 13.6 Stage selector — `header-stage-select` cambia stage del thread
- [ ] 13.7 Back to kanban — `header-back-kanban` vuelve a vista kanban
- [ ] 13.8 Back to parent — `header-back-parent` vuelve a vista anterior
- [x] 13.9 View board — `header-view-board` abre vista board del proyecto
- [x] 13.10 Preview — `header-preview` abre preview
- [x] 13.11 Open in editor — `header-open-editor` abre editor externo
- [ ] 13.12 Toggle terminal — `header-toggle-terminal` abre/cierra terminal
- [x] 13.13 Toggle review — `header-toggle-review` abre/cierra review pane
- [x] 13.14 Startup commands — `header-startup-commands` muestra comandos

## 14. Automation Inbox — `automation-inbox.spec.ts`

- [x] 14.1 Inbox renders — Lista resultados de automaciones
- [x] 14.2 Manage automations — `inbox-manage-automations` navega a settings
- [x] 14.3 Tab filter — `inbox-tab-{status}` filtra por pending/reviewed/dismissed
- [x] 14.4 Search — `inbox-search` busca en resultados
- [x] 14.5 Project filter — `inbox-project-filter` filtra por proyecto

## 15. WebSocket y Real-Time — `websocket.spec.ts`

- [x] 15.1 WS connects on load — WebSocket se establece al cargar
- [x] 15.2 agent:message updates chat — Mensajes nuevos en tiempo real (WS inject)
- [x] 15.3 agent:status updates badge — Cambios de status reflejados (WS inject)
- [x] 15.4 agent:tool_call shows card — Tool calls como cards expandibles (WS inject)
- [x] 15.5 agent:result shows completion — Resultado muestra AgentResultCard (WS inject)
- [x] 15.6 Worktree setup events — Progress steps via WS inject
- [x] 15.7 thread:created updates sidebar — Nuevo thread aparece sin recargar (WS inject)
- [x] 15.8 WS reconnection — Desconexion y reconexion automatica

## 16. Analytics — `analytics.spec.ts`

- [x] 16.1 Analytics view renders with mocked data — MetricCards muestran datos (API mock)
- [x] 16.2 Metric cards display correct counts — Counts 42/35 visibles
- [x] 16.3 Cost card shows when totalCost > 0 — `analytics-cost-card` visible con $1.2345
- [x] 16.4 Cost card hidden when totalCost is 0 — `analytics-cost-card` no visible
- [x] 16.5 Stage distribution chart renders — `analytics-stage-chart` visible
- [x] 16.6 Timeline chart renders — `analytics-timeline-chart` visible
- [x] 16.7 Time range selector changes data — `analytics-time-range-week` envia timeRange=week
- [x] 16.8 Group by selector changes timeline — `analytics-group-by-week` envia groupBy=week
- [x] 16.9 Project filter sends correct projectId — Filtro proyecto en request
- [x] 16.10 No data message when overview is empty — `analytics-no-data` visible
- [x] 16.11 Navigate to analytics via sidebar — `sidebar-analytics` navega a /analytics
- [x] 16.12 Loading spinner shows while fetching — `analytics-loading` visible

## 17. Grid/Live Columns View — `grid-view.spec.ts`

- [x] 17.1 Grid view shows empty state — `grid-empty-state` visible sin threads activos
- [x] 17.2 Grid view accessible via sidebar — `sidebar-grid` navega a /grid
- [x] 17.3 Grid view has add thread button — `grid-add-thread` visible
- [x] 17.4 Add thread button opens project picker — Popover muestra proyectos
- [x] 17.5 Grid view shows title — `grid-view` visible con "Grid" text
- [x] 17.6 Grid with active threads shows columns — `grid-container` con columnas (mocked)
- [x] 17.7 Grid empty state shows descriptive text — "No active threads" visible
- [x] 17.8 Grid persists size in localStorage — `funny:grid-cols`/`funny:grid-rows`
- [x] 17.9 Grid view does not crash with multiple projects — Sin errores

## 18. Edge Cases y UX — `edge-cases.spec.ts`

- [x] 18.1 Empty project (no threads) — Proyecto sin threads muestra estado vacio
- [ ] 18.2 Long thread title truncation — Titulos largos se truncan con ellipsis
- [x] 18.3 Thread view loads with message data — Carga correctamente con datos
- [x] 18.4 Multiple projects in sidebar — 5+ proyectos se listan correctamente
- [x] 18.5 Toast notifications — CRUD muestra toasts exito/error
- [x] 18.6 Error state on invalid project — App maneja gracefully sin crash
- [x] 18.7 Loading states — Skeletons y spinners durante cargas
- [x] 18.8 Navigation with browser back/forward — Botones navegador funcionan
- [x] 18.9 Deep link to thread — URL directa carga correctamente
- [ ] 18.10 Concurrent thread operations — Multiples threads running sin interferencia

---

## A. Accesibilidad — `accessibility.spec.ts`

- [x] A.1 Sidebar icons have accessible labels — Botones de iconos tienen aria-label o title
- [x] A.2 Focus trap in NewThreadDialog — Tab no escapa del dialog abierto
- [x] A.3 Focus returns on dialog close — Foco vuelve al trigger al cerrar
- [x] A.4 Command palette ARIA roles — dialog role, options role
- [x] A.5 Icon buttons have accessible labels — Botones sin texto tienen aria-label
- [x] A.6 Delete dialogs have proper structure — role=dialog/alertdialog con titulo
- [x] A.7 Keyboard can navigate sidebar — Focus y Enter funcionan en proyectos

## B. Keyboard Shortcuts — `keyboard-shortcuts.spec.ts`

- [x] B.1 Ctrl+K opens command palette
- [x] B.2 Escape closes command palette
- [x] B.3 Ctrl+Shift+F navigates to /list
- [x] B.4 Escape closes NewThread dialog
- [x] B.5 Escape closes settings dialog
- [x] B.6 Ctrl+K with textarea focused — no crash
- [x] B.7 Enter in rename dialog submits
- [x] B.8 Escape in lightbox — no crash

## C. Responsive / Viewport — `responsive.spec.ts`

- [x] C.1 Small viewport (1024x768) — app funcional, sin overflow
- [x] C.2 Large viewport (1920x1080) — review pane + thread caben
- [x] C.3 Very small viewport (800x600) — sin crash
- [x] C.4 Sidebar min-width respetado
- [x] C.5 Review pane resize respeta limites
- [x] C.6 Kanban en viewport estrecho
- [x] C.7 Settings en viewport pequeno

## D. API Error Handling — `api-errors.spec.ts`

- [x] D.1 500 on project create — toast de error, sin crash
- [x] D.2 404 on thread load — error graceful
- [x] D.3 Network timeout — loading state, sin hang
- [x] D.4 401 unauthorized — manejo graceful
- [x] D.5 Malformed JSON response — sin crash
- [x] D.6 Diff API error — review pane sigue funcional
- [x] D.7 Bootstrap failure — muestra fallback

## E. Internacionalizacion (i18n) — `i18n.spec.ts`

- [x] E.1 Language switch to Spanish — UI se traduce
- [x] E.2 Language persists after reload
- [x] E.3 All three languages available — en, es, pt
- [x] E.4 Long translations no overflow

## F. Dark Mode — `dark-mode.spec.ts`

- [x] F.1 Theme persists on reload — dark persiste tras recarga
- [x] F.2 Dark mode on all views — list, kanban, analytics, settings
- [x] F.3 Light mode works correctly — sin dark class
- [x] F.4 No invisible text in dark mode — text != background
- [x] F.5 Theme toggle cycles correctly — light/dark/system sin crash
- [x] F.6 System theme respects OS preference — emulateMedia funciona

## G. Git Edge Cases — `git-edge-cases.spec.ts`

- [x] G.1 Empty diff — review pane muestra estado limpio
- [x] G.3 Very long filename — sin overflow de layout
- [x] G.4 Special chars in filename — espacios, unicode
- [x] G.5 Commit empty message — boton deshabilitado o error
- [x] G.6 Multiple file types in diff — js, css, json, md
- [x] G.7 Modified file status badge — README.md con badge M
- [x] G.8 Deleted file status badge — README.md con badge D
- [x] G.9 Binary file — sin crash en diff viewer
- [x] G.10 Large number of files (50) — review pane maneja virtualizado

## H. Data Persistence — `data-persistence.spec.ts`

- [x] H.1 Project order persists after reload
- [x] H.2 Thread pin persists after reload
- [x] H.3 Selected thread route restores via back
- [x] H.4 Review pane width persists en localStorage
- [x] H.5 Thread stage persists en kanban
- [x] H.6 Archived thread not shown in normal views

## I. Multi-Tab / Concurrent — `multi-tab.spec.ts`

- [x] I.1 Thread created in tab A appears in tab B
- [x] I.2 Delete project in one tab, other tab handles it
- [x] I.3 Multiple tabs on different routes work independently

## J. Performance — `performance.spec.ts`

- [x] J.1 Initial load under 5 seconds
- [x] J.2 Navigation between views under 3 seconds
- [x] J.3 15 projects render without lag
- [x] J.4 Rapid thread switching — sin JS errors
- [x] J.5 Command palette opens under 500ms
- [x] J.6 Settings dialog opens under 1 second
- [x] J.7 No memory leaks on repeated navigation

## K. Clipboard & Copy — `clipboard.spec.ts`

- [x] K.1 Copy text via header menu
- [x] K.2 Copy all via header menu
- [x] K.3 Copy file path from review pane
- [x] K.4 Message copy button works

## L. Security (Client-Side) — `security.spec.ts`

- [x] L.1 XSS in project name — escaped, no alert
- [x] L.2 XSS in thread title — escaped, no alert
- [x] L.3 XSS in commit message — escaped, no alert
- [x] L.4 XSS in search input — escaped, title unchanged
- [x] L.5 Auth token not leaked in URL
- [x] L.6 No sensitive data in localStorage
- [x] L.7 XSS in project rename — escaped, no alert
- [x] L.8 HTML injection in command palette search
- [x] L.9 XSS via prompt textarea

## M. Notifications & Toasts (UX) — `notifications.spec.ts`

- [ ] M.1 Success toast on operations — project creation, repo init, configs
- [ ] M.2 Error toast on API failure — Muestra el mensaje del backend claro
- [ ] M.3 Toast auto-dismissal — Desaparecen automáticamente (ej. 5 segundos)
- [ ] M.4 Toast manual dismissal — Botón (x) funciona instantáneamente
- [ ] M.5 Toast styling by theme — Buen contraste de texto en modo light y modo dark
- [ ] M.6 Multiple toasts queuing — Se apilan dinámicamente sin solaparse
- [ ] M.7 Actionable toasts — Funcionalidades interactivas (ej "Undo") funcionan

## N. Offline & Network Errors — `offline-state.spec.ts`

- [ ] N.1 Offline indicator appears — Detecta `navigator.onLine == false` y avisa
- [ ] N.2 Action disablement — Deshabilita prompt-send o syncs crítiicos al caer la red
- [ ] N.3 Auto-reconnect — Restaura la vista y limpia los flags offline al regresar la conectividad
- [ ] N.4 Queued operations retry — (Si implementado) reintenta las peticiones pendientes

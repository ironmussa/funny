# Open Design — Especificación de Producto

> Clon open source de **Claude Design** (Anthropic Labs, lanzado 2026-04-17). El objetivo es replicar el ciclo _prompt → prototipo interactivo → handoff a código de producción_, sobre proveedores LLM intercambiables, y publicarlo bajo licencia OSS.

---

## 1. Visión

Una aplicación web auto-hosteable que permite a equipos:

1. Generar prototipos visuales (HTML interactivo, slides, mockups, one-pagers) describiéndolos en lenguaje natural.
2. Refinarlos por conversación, comentarios inline, edición directa o sliders dinámicos.
3. Aplicar automáticamente el **design system** del equipo leyendo su codebase y archivos de diseño.
4. Exportar a múltiples formatos y entregar al desarrollador como un **bundle ejecutable** que puede consumir Claude Code u otro agente.

Diferenciador OSS: proveedor LLM intercambiable (Anthropic / OpenAI / local), datos en infraestructura del usuario, integración nativa con `funny` (los bundles se convierten en threads de agente).

---

## 2. Casos de Uso Núcleo

| #   | Caso                                                 | Output                                   |
| --- | ---------------------------------------------------- | ---------------------------------------- |
| 1   | Landing page desde un brief                          | HTML interactivo + assets                |
| 2   | Pitch deck / one-pager                               | PPTX, PDF, Canva                         |
| 3   | Wireframes / flows de producto                       | HTML + JSON de pantallas                 |
| 4   | Mockup con componentes funcionales (chat, video, 3D) | HTML con dependencias declaradas         |
| 5   | Handoff a Claude Code / agente                       | Bundle (`design.json` + assets + prompt) |

---

## 3. Features

### 3.1 Generación inicial (inputs → diseño)

Acepta como entrada:

- **Texto** (prompt en lenguaje natural)
- **Imágenes** (referencias, screenshots de inspiración)
- **Documentos**: `.docx`, `.pptx`, `.xlsx`, `.md`, `.pdf`
- **URLs**: scrapea HTML/CSS y captura screenshot
- **Codebase / repo**: ingiere para inferir design system existente

Salida primaria: **HTML interactivo** generado por el LLM en un sandbox iframe.

### 3.2 Refinamiento

Tres modos coexistentes (no excluyentes):

1. **Chat** — instrucciones en lenguaje natural; el LLM emite un patch del HTML.
2. **Comentarios inline** — el usuario click-selecciona un elemento del iframe (Inspector) y deja un comentario; se envía como prompt contextualizado con el selector y el snippet.
3. **Edición directa** — texto editable in-place (`contenteditable`) y propiedades visuales editables.
4. **Sliders dinámicos** — el LLM, ante un prompt ambiguo ("hazlo más cálido"), genera controles UI (sliders/toggles) que parametrizan tokens (color, spacing, radius). El cambio re-renderiza sin re-generar.

### 3.3 Design System

- **Onboarding**: el usuario conecta un repo Git y/o sube tokens (`tokens.json`, archivos Figma exportados, CSS/Tailwind config).
- **Extracción**: pipeline que parsea `tailwind.config.*`, CSS variables, `theme.ts`, MUI/Chakra themes, y deriva una representación canónica:
  ```
  { colors, typography, spacing, radii, shadows, components[] }
  ```
- **Aplicación**: cada generación incluye el design system como contexto de sistema (cache prompts) y reglas duras ("usa solo estos colores").
- **Múltiples sistemas** por organización (marcas distintas).

### 3.4 Export

| Formato            | Implementación                                                                    |
| ------------------ | --------------------------------------------------------------------------------- |
| HTML standalone    | bundle estático (HTML + CSS + JS inline o assets)                                 |
| PDF                | Playwright `page.pdf()`                                                           |
| PPTX               | `pptxgenjs` con captura por slide                                                 |
| Canva              | Canva Connect API (OAuth)                                                         |
| URL compartida     | hosteo interno con ACL (org-only / public)                                        |
| **Handoff bundle** | ZIP con `design.json` (intent + tokens + componentes) + HTML + prompt para agente |

### 3.5 Colaboración

- **Org-scoped sharing**: view-only / edit / chat
- **Multi-usuario**: varios pueden editar y conversar con el LLM en paralelo (al estilo Figma multiplayer, pero turn-based para el LLM)
- **Versionado**: cada cambio del LLM crea una versión; rollback / branch / compare

---

## 4. Arquitectura Técnica

### 4.1 Stack propuesto

Reutilizar el stack de `funny` para máxima sinergia:

- **Monorepo**: Bun workspaces
- **Backend**: Hono + Bun (`packages/server`, `packages/runtime`)
- **DB**: SQLite (default) / PostgreSQL (Drizzle ORM)
- **Cliente**: React 19 + Vite + shadcn/ui + Tailwind
- **Auth**: Better Auth (ya en `funny`)
- **LLM SDK**: provider-agnostic abstraction sobre `@anthropic-ai/sdk`, `openai`, etc.

### 4.2 Componentes nuevos

```
packages/
  design-core/         # Lógica pura: pipelines de generación, parsers de design system
    src/
      generators/      # prompt → HTML, prompt → PPTX, etc.
      design-system/   # extractores (tailwind, css-vars, figma, theme.ts)
      patcher/         # diff/patch HTML por instrucción
      bundler/         # handoff bundle (design.json + assets)
  design-runtime/      # Servicios HTTP/WS específicos
    src/
      routes/
        designs.ts     # CRUD designs
        ingest.ts      # codebase/url/file ingestion
        patch.ts       # streaming patches
        export.ts      # PDF/PPTX/HTML/bundle
      services/
        sandbox.ts     # iframe sandboxing + Inspector bridge
        ds-extractor.ts
        slider-gen.ts
  design-client/       # SPA o ruta dentro del cliente actual
    src/
      DesignCanvas/    # iframe + Inspector overlay
      ChatPanel/       # conversación con el LLM
      DesignSystemPanel/
      ExportDialog/
```

### 4.3 Modelo de datos (Drizzle)

```ts
designs; // id, orgId, ownerId, title, currentVersionId, createdAt
design_versions; // id, designId, html, css, tokensSnapshot, parentVersionId, prompt, createdBy, createdAt
design_systems; // id, orgId, name, tokens(JSON), components(JSON), sourceRepo
ds_imports; // id, designSystemId, sourceType (repo|figma|tokens|css), payload, status
design_comments; // id, versionId, selector, body, authorId, resolvedAt
design_assets; // id, designId, kind (image|font|model3d), url, sha256
share_links; // id, designId, scope (org|public), permission (view|comment|edit), token
```

### 4.4 API (HTTP/WS)

```
POST   /api/designs                          # crear (con prompt + opt design_system_id)
GET    /api/designs/:id
POST   /api/designs/:id/messages             # turn de chat → stream de patch
POST   /api/designs/:id/inline-comment       # comentario sobre selector
POST   /api/designs/:id/direct-edit          # edición directa (path + nuevo valor)
POST   /api/designs/:id/sliders/apply        # aplica valores de sliders
POST   /api/designs/:id/versions/:vid/fork
POST   /api/designs/:id/export               # body: { format: pdf|pptx|html|bundle|canva }

POST   /api/design-systems                   # crear desde repo/tokens/figma
GET    /api/design-systems/:id
POST   /api/design-systems/:id/refresh       # re-extraer

WS     /ws  (multiplexed events)             # design:patch, design:slider_def, design:status
```

### 4.5 Pipeline de generación (alto nivel)

```
prompt + ds_tokens + history
        │
        ▼
[ system prompt (cached) ] ──► LLM (streaming)
        │
        ▼
parser ── HTML/CSS válidos? ── no ──► self-repair turn (1 retry)
        │ sí
        ▼
sandbox render (iframe srcdoc, sin red salvo whitelisted CDNs)
        │
        ▼
emit `design:patch` por WS  + persiste design_version
```

### 4.6 Inspector / Inline edit

- Iframe sandboxed con `postMessage` bridge.
- Overlay del cliente captura clicks, computa selector estable (path o `data-design-id`).
- Ediciones directas se envían como `JSONPatch` sobre un AST (HAST) del documento — más confiable que regex sobre HTML crudo.
- Detalle completo en [decisions.md §2](./decisions.md#2-edición-hast--jsonpatch).

### 4.7 Sliders dinámicos

- Cuando el LLM detecta ambigüedad estética, en lugar de re-generar emite un bloque de controles UI parametrizables (sliders, toggles, color pickers).
- Los controles mutan **CSS variables** dentro del iframe — cambio instantáneo, **0 tokens** consumidos.
- Detalle completo, formato del bloque y limitaciones en [decisions.md §5](./decisions.md#5-sliders-dinámicos).

### 4.8 Provider abstraction

```ts
interface LLMProvider {
  generateDesign(req: DesignRequest): AsyncIterable<DesignChunk>;
  patchDesign(req: PatchRequest): AsyncIterable<PatchChunk>;
  vision(req: VisionRequest): Promise<VisionResult>;
}
```

Implementaciones: `AnthropicProvider`, `OpenAIProvider`, `LocalProvider` (Ollama/LM Studio para vision-capable models).

---

## 5. Integración con `funny`

El handoff bundle es un thread input nativo:

1. Usuario click "Send to funny" en Open Design.
2. Open Design genera `bundle.zip` y POST a `/api/threads` con:
   ```json
   {
     "projectId": "...",
     "mode": "worktree",
     "prompt": "Implementa el diseño adjunto siguiendo `design.json`...",
     "attachments": ["bundle://xyz"]
   }
   ```
3. `funny` arranca un agente Claude Code en un worktree, con el bundle montado.

---

## 6. Roadmap por fases

### Fase 0 — Spike (1 semana)

- Prompt → HTML standalone en iframe sandbox.
- Chat refinement (sin inline edit).
- Provider Anthropic únicamente.

### Fase 1 — MVP (3-4 semanas)

- Inspector + comentarios inline.
- Edición directa (`contenteditable` + JSONPatch).
- Export PDF + HTML.
- Persistencia + versionado.
- Auth multiusuario (Better Auth).

### Fase 2 — Design Systems

- Extracción desde `tailwind.config` + CSS variables.
- Aplicación en generación (prompt caching del DS).
- UI de gestión de DS.

### Fase 3 — Avanzado

- Sliders dinámicos.
- Export PPTX + Canva.
- Handoff a `funny`.
- Provider OpenAI + local.

### Fase 4 — Colaboración

- Multi-usuario en vivo (CRDT o turn-based).
- Share links + ACL.
- Comentarios threaded.

---

## 7. Trade-offs y decisiones abiertas

| Decisión             | Opciones                                      | Recomendación inicial          | Detalle                                                     |
| -------------------- | --------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Output del LLM       | HTML directo / JSON estructurado / React      | **HTML + Tailwind**            | [decisions §1](./decisions.md#1-output-html--tailwind)      |
| Edición              | Re-prompt full / regex / AST diff             | **HAST + JSONPatch**           | [decisions §2](./decisions.md#2-edición-hast--jsonpatch)    |
| Sandbox              | iframe srcdoc / iframe + workerd / Shadow DOM | **iframe srcdoc + CSP**        | [decisions §3](./decisions.md#3-sandbox-iframe-srcdoc--csp) |
| Multiplayer          | CRDT (Yjs) / turn-based                       | **Turn-based** en MVP          | [decisions §4](./decisions.md#4-multiplayer)                |
| Sliders              | Re-prompt / CSS vars                          | **CSS vars sin re-prompt**     | [decisions §5](./decisions.md#5-sliders-dinámicos)          |
| Storage de versiones | Snapshot completo / delta                     | Snapshot + GC tras N versiones | —                                                           |
| Vision               | Modelo del provider / OCR adicional           | Modelo del provider            | —                                                           |

---

## 8. Riesgos y mitigaciones

- **Costo de tokens**: el LLM regenera HTML completo en cada turn. → Mitigación: prompt caching agresivo del DS y system prompt; patches incrementales tras turn 1.
- **Seguridad del HTML generado**: el LLM podría inyectar `<script>` malicioso. → Mitigación: CSP estricto en el iframe (`script-src 'none'` por default), allowlist explícita por usuario.
- **Accesibilidad**: el LLM ignora ARIA/contraste. → Mitigación: linter post-generación (axe-core) que añade un turn de auto-fix.
- **Calidad inconsistente**: en flujos complejos el output diverge. → Mitigación: templates estructurados (slides) vs. free-form (landings).

---

## 9. Métricas de éxito

- **TTFD** (Time To First Design): < 8s desde prompt a iframe pintado.
- **Patch turn**: < 4s p50.
- **DS adherence**: > 90% de colores/spacings generados pertenecen a tokens del DS.
- **Export fidelity**: PDF/PPTX visualmente equivalente al HTML (diff perceptual < 5%).
- **Costo por sesión**: < $0.50 en tokens (sesión = 5 turns).

---

## 10. Referencias

- [Anthropic — Introducing Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs)
- [TechCrunch coverage](https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/)
- [VentureBeat — challenges Figma](https://venturebeat.com/technology/anthropic-just-launched-claude-design-an-ai-tool-that-turns-prompts-into-prototypes-and-challenges-figma)
- [MacRumors — debut details](https://www.macrumors.com/2026/04/17/anthropic-claude-design/)
- [Agence Scroll — 2026 Guide](https://agence-scroll.com/en/blog/claude-design-anthropic-2026-guide)

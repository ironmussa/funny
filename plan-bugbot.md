# Plan: ReviewBot — Code Review Agent (estilo Cursor BugBot)

## Decisión arquitectónica

Crear un paquete dedicado **`packages/reviewbot`** (`@funny/reviewbot`) que consume de `@funny/core/git` y `@funny/shared`. Esto lo mantiene desacoplado de `@funny/agent` (el pipeline de quality) y permite que evolucione independientemente.

Las funciones GitHub que faltan (`getPRDiff`, `getPRInfo`, `postPRReview`) van en `@funny/core/git/github.ts` porque son reutilizables por cualquier paquete.

Los tipos compartidos de code review van en `@funny/shared/src/types.ts`.

---

## V1 — Implementación simple (single-pass)

### Paso 1: Funciones GitHub en `@funny/core/git/github.ts`

Agregar 3 funciones al módulo existente:

```typescript
getPRDiff(cwd, prNumber) → ResultAsync<string, DomainError>
// → gh pr diff <number>

getPRInfo(cwd, prNumber) → ResultAsync<PRInfo, DomainError>
// → gh pr view <number> --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles

postPRReview(cwd, prNumber, body, event) → ResultAsync<string, DomainError>
// → gh pr review <number> --approve|--request-changes|--comment --body "..."
```

Exportar desde `packages/core/src/git/index.ts`.

### Paso 2: Tipos en `@funny/shared/src/types.ts`

```typescript
interface PRInfo { number, title, body, author, headBranch, baseBranch, additions, deletions, changedFiles }
interface CodeReviewFinding { severity, category, file, line?, description, suggestion? }
interface CodeReviewResult { prNumber, status, summary, findings[], duration_ms, model }
interface TriggerReviewRequest { prNumber, model?, provider? }
```

### Paso 3: Paquete `packages/reviewbot`

Estructura:

```
packages/reviewbot/
├── package.json          (@funny/reviewbot)
├── src/
│   ├── index.ts          # Barrel export
│   ├── reviewer.ts       # Core: fetch PR → analyze → post review
│   ├── prompts.ts        # System prompt para el agente reviewer
│   ├── formatter.ts      # Formatea findings como markdown para GitHub
│   └── types.ts          # Tipos internos del paquete
```

**`reviewer.ts`** — La clase principal `PRReviewer`:

- `review(cwd, prNumber, options?)` — flujo completo:
  1. `getPRInfo()` + `getPRDiff()` desde `@funny/core/git`
  2. Ejecuta `AgentExecutor` con prompt de review + diff como contexto
  3. Parsea resultado como `CodeReviewFinding[]`
  4. Formatea como markdown
  5. `postPRReview()` en GitHub

**`prompts.ts`** — System prompt que le dice al agente:

- Analiza el diff buscando: bugs, seguridad, performance, lógica, estilo
- Devuelve JSON estructurado con findings
- NO aplica cambios, solo reporta

**`formatter.ts`** — Convierte `CodeReviewFinding[]` en markdown para GitHub:

- Agrupa por severidad
- Incluye file:line references
- Incluye suggestions cuando hay
- Decide si APPROVE, REQUEST_CHANGES, o COMMENT según severidad

### Paso 4: Integración webhook en `@funny/agent`

Extender `packages/agent/src/routes/webhooks.ts`:

- `pull_request.opened` → trigger review
- `pull_request.synchronize` → trigger review
- Importa `PRReviewer` de `@funny/reviewbot`

---

## Archivos a modificar

- `packages/core/src/git/github.ts` — +3 funciones + tipos PRInfo
- `packages/core/src/git/index.ts` — exportar nuevas funciones
- `packages/shared/src/types.ts` — +4 interfaces de code review
- `packages/agent/src/routes/webhooks.ts` — handler PR opened/synchronize
- `package.json` (root) — ya tiene `"packages/*"` en workspaces, no necesita cambio

## Archivos a crear

- `packages/reviewbot/package.json`
- `packages/reviewbot/src/index.ts`
- `packages/reviewbot/src/reviewer.ts`
- `packages/reviewbot/src/prompts.ts`
- `packages/reviewbot/src/formatter.ts`
- `packages/reviewbot/src/types.ts`

---

## Fases futuras

### V2 — Multi-pass con voting

- N pasadas paralelas (configurable, default 3-5) con diff en orden aleatorio
- Majority voting: solo sobreviven bugs flaggeados en 2+ pasadas
- Normalización: merge de buckets similares en un solo finding
- Mejora dramática en precision (reduce false positives)

### V3 — Validator model

- Modelo separado (más barato, e.g. Haiku) que recibe cada finding y decide: real bug o false positive
- Category filtering configurable: ignorar warnings de docs, estilos menores, etc.
- Deduplicación contra comentarios previos del bot en el mismo PR

### V4 — Agentic design

- El reviewer se convierte en agente completo con tools (Read, Grep, Glob)
- Puede hacer checkout del código y navegar el repo, no solo leer el diff
- Decide autónomamente dónde investigar más profundo
- Aggressive prompting: investigar cada patrón sospechoso

### V5 — ReviewBot rules (codebase-specific)

- Archivo `.reviewbot/rules.yaml` en cada repo
- Reglas custom: "nunca usar X", "este patrón es unsafe", "migrations deben tener down"
- El agente recibe las rules como contexto adicional
- Permite encodear invariantes del proyecto sin hardcodear

### V6 — Métricas y feedback loop

- Resolution rate: trackear si los findings se resolvieron antes del merge
- ReviewBench interno: benchmark con diffs + bugs anotados por humanos
- A/B testing de prompts y configuraciones
- Dashboard de métricas por repo/equipo

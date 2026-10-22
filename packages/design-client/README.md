# @funny/design-client

Frontend de **Open Design** — clon open source de Claude Design (Anthropic Labs, 2026).

Genera prototipos visuales interactivos a partir de prompts en lenguaje natural y los entrega como bundles ejecutables a `funny` (o cualquier agente compatible con Claude Code).

## Estado

🚧 En diseño — ver [docs/open-design.md](./docs/open-design.md) para la especificación completa.

El paquete incluye una página estática de presentación; la aplicación de generación y edición todavía no está implementada.

## Build

Desde la raíz del repositorio:

```bash
bun install
bun run --cwd packages/design-client build
```

Vite genera `packages/design-client/dist/index.html`. Puedes servir el resultado con `bun run --cwd packages/design-client preview`. Como la entrada es HTML y no hay código TypeScript, este build no necesita un `tsconfig.json` ni un paso de typecheck.

## Decisiones técnicas clave

- **Output:** HTML + Tailwind (no React, no JSON intermedio)
- **Edición:** HAST (Hypertext AST de unified/rehype) + JSONPatch (RFC 6902)
- **Sandbox:** iframe `srcdoc` con CSP estricta
- **Multiplayer:** turn-based en MVP; Yjs/CRDT post-MVP
- **Sliders:** mutan CSS variables sin re-prompt al LLM

Ver [docs/decisions.md](./docs/decisions.md) para el detalle de cada decisión.

# Open Design — Decisiones técnicas

Este documento expande las decisiones técnicas clave declaradas en [open-design.md §7](./open-design.md). Cada sección responde **qué**, **por qué** y **cómo**.

---

## 1. Output: HTML + Tailwind

**Qué:** El LLM emite HTML semántico con clases de Tailwind. No React, no JSON intermedio, no un DSL custom.

**Por qué:**

| Alternativa                    | Problema                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- |
| React JSX                      | Requiere bundler; los modelos lo generan peor que HTML; harder to sandbox     |
| JSON estructurado (Figma-like) | Necesitas un renderer custom que se queda atrás del estándar                  |
| DSL propio                     | Aprendizaje del modelo + del usuario; ecosistema cero                         |
| HTML + Tailwind ✅             | Modelos lo generan excelente; ejecuta en cualquier `<iframe>`; exporta nativo |

**Cómo:**

- Tailwind se carga vía CDN (`https://cdn.tailwindcss.com`) **dentro** del iframe en MVP — cero build step.
- Para producción/exports, se compila con `@tailwindcss/cli` standalone para purgar clases no usadas.
- El system prompt incluye el design system del usuario como `tailwind.config.js` parcial (paleta, fuentes, radii).

---

## 2. Edición: HAST + JSONPatch

**Qué:** Los cambios al diseño se aplican como operaciones sobre el árbol HAST, no como reemplazos de string.

### Qué es HAST

HAST = **H**ypertext **A**bstract **S**yntax **T**ree. Parte del ecosistema [unified/rehype](https://github.com/syntax-tree/hast). Cada nodo HTML se representa como objeto JS:

```html
<div class="card"><h1>Hola</h1></div>
```

```js
{
  type: 'element',
  tagName: 'div',
  properties: { className: ['card'] },
  children: [
    {
      type: 'element',
      tagName: 'h1',
      properties: {},
      children: [{ type: 'text', value: 'Hola' }]
    }
  ]
}
```

### Por qué HAST + JSONPatch en vez de regex sobre HTML

| Problema con regex/string-replace                         | Solución con HAST                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<div class="x">` aparece 50 veces — ¿cuál editas?        | Cada nodo tiene un path único: `children[0].children[2]`                                               |
| HTML mal-cerrado o comentarios rompen el regex            | Parser robusto, normaliza                                                                              |
| Atributos quoted/unquoted, espacios, mayúsculas           | Normalizado automáticamente                                                                            |
| Edits concurrentes generan conflictos                     | JSONPatch (RFC 6902) es estándar mergeable                                                             |
| Ediciones del LLM como "remplaza el texto X" son ambiguas | Patch operacional explícito: `{ op: 'replace', path: '/children/0/children/0/value', value: 'Nuevo' }` |

### Pipeline

```
HTML del LLM
    │
    ▼  rehype-parse
   HAST (árbol mutable)
    │
    ├─► Cliente Inspector: click en nodo → emite path
    ├─► Direct edit: contenteditable → emite { path, newValue } como JSONPatch
    ├─► Chat refinement: LLM emite array de JSONPatch ops
    │
    ▼  applyPatch()
HAST'  (nuevo estado)
    │
    ▼  rehype-stringify
HTML' (nuevo render)
```

### Ejemplo de patch del LLM

Usuario: _"cambia el botón principal a verde"_.

LLM responde con:

```json
[
  {
    "op": "replace",
    "path": "/children/1/children/0/properties/className",
    "value": ["bg-green-500", "text-white", "px-4", "py-2", "rounded"]
  }
]
```

Costo: ~50 tokens en vez de re-emitir el HTML completo (~3000 tokens).

### Librerías

- [`hast-util-from-html`](https://github.com/syntax-tree/hast-util-from-html) — parse
- [`hast-util-to-html`](https://github.com/syntax-tree/hast-util-to-html) — stringify
- [`fast-json-patch`](https://github.com/Starcounter-Jack/JSON-Patch) — apply patches
- [`hast-util-select`](https://github.com/syntax-tree/hast-util-select) — query con CSS selectors

---

## 3. Sandbox: iframe `srcdoc` + CSP

**Qué:** El HTML generado se ejecuta dentro de un `<iframe srcdoc="...">` con Content Security Policy estricta.

**Por qué:**

- El LLM puede inyectar `<script>` accidental o malicioso (prompt injection desde inputs del usuario).
- Un iframe `srcdoc` aísla el documento del DOM principal — no acceso a `window.parent` salvo `postMessage`.
- CSP previene cargas de red no autorizadas y bloquea scripts inline por default.

**Cómo:**

```html
<iframe
  srcdoc="<!DOCTYPE html><meta http-equiv='Content-Security-Policy' content='default-src none; style-src https://cdn.tailwindcss.com unsafe-inline; img-src https: data:; font-src https: data:'>..."
  sandbox="allow-same-origin"
  referrerpolicy="no-referrer"
></iframe>
```

Bridge cliente ↔ iframe vía `postMessage`:

- iframe → cliente: `{ type: 'click', path: '/children/0/...' }` (Inspector)
- cliente → iframe: `{ type: 'set-css-var', name: '--primary-hue', value: '220' }` (sliders)

Allowlist explícita de scripts (chat embeds, video players) gestionada por user toggle, nunca default.

---

## 4. Multiplayer

**Qué:** Cómo manejar múltiples usuarios editando el mismo diseño.

### Modelo turn-based (MVP)

- **Una cola FIFO por diseño** para prompts al LLM. Solo un usuario "tiene el turno" a la vez.
- Los demás ven la generación en streaming (broadcast vía WS).
- **Edits no-LLM** (texto directo, sliders, comentarios) son concurrentes y no requieren turno — son ops simples sobre HAST que se mergean por last-write-wins.
- **Presence** (avatares de quién está viendo + cursor) usando heartbeat por WS.

```
Usuario A: "Hazlo más oscuro"     ─┐
Usuario B: "Cambia el título"      ├─► cola por design_id
                                   ▼
                            LLM procesa A → broadcast patch
                            LLM procesa B → broadcast patch
```

**Ventajas:** trivial de implementar, sin conflictos del LLM, costo predecible.

**Desventajas:** colaboración secuencial; si dos usuarios refinan a la vez, esperan turno.

### Modelo CRDT en vivo (post-MVP, tipo Figma)

- [Yjs](https://github.com/yjs/yjs) o [Automerge](https://automerge.org/) sincronizan el estado HAST entre clientes.
- Cada usuario tiene su cursor; cambios se mergean automáticamente.
- Los prompts al LLM siguen siendo turn-based, pero sus patches se aplican como ops Yjs (mergeables con edits humanos).

**Por qué no MVP:**

- CRDT sobre HAST requiere definir un "tipo Yjs" custom (Y.XmlElement existe pero hay edge cases).
- Decisión de cómo intercalar el output del LLM con edits humanos en vivo es no-trivial.
- Costo de infraestructura (servidor de sync) vs. WS broadcast simple.

**Plan de migración:** la capa de versionado en `design_versions` se diseña para poder ser reemplazada por un Y.Doc sin migrar el resto. La frontera está en cómo se generan los patches.

---

## 5. Sliders dinámicos

**Qué:** Cuando el usuario expresa una intención **modulable** ("hazlo más cálido", "más espacioso", "más redondeado"), el LLM no regenera el HTML — emite **controles UI parametrizables** que el cliente renderiza. El usuario los mueve y la página se actualiza **sin volver a llamar al LLM**.

### Mecanismo

**Paso 1.** El HTML generado expone tokens estéticos como CSS variables:

```html
<style>
  :root {
    --primary-hue: 220;
    --radius: 8px;
    --spacing-scale: 1;
  }
  .button {
    background: hsl(var(--primary-hue) 70% 50%);
    border-radius: var(--radius);
    padding: calc(0.5rem * var(--spacing-scale)) calc(1rem * var(--spacing-scale));
  }
</style>
```

**Paso 2.** El system prompt instruye al LLM: _"si el usuario pide un ajuste estético modulable, responde con un bloque `sliders` en vez de regenerar HTML"_.

**Paso 3.** El LLM responde con un bloque estructurado:

```json
{
  "type": "sliders",
  "controls": [
    {
      "var": "--primary-hue",
      "label": "Tono",
      "min": 0,
      "max": 360,
      "value": 220,
      "unit": ""
    },
    {
      "var": "--radius",
      "label": "Redondez",
      "min": 0,
      "max": 24,
      "value": 8,
      "unit": "px"
    },
    {
      "var": "--spacing-scale",
      "label": "Espaciado",
      "min": 0.5,
      "max": 2,
      "step": 0.1,
      "value": 1
    }
  ]
}
```

**Paso 4.** El cliente renderiza un panel con shadcn `<Slider>` por control. Al mover el slider:

```ts
iframe.contentDocument.documentElement.style.setProperty('--primary-hue', value);
```

**Cambio instantáneo en el iframe. Cero tokens consumidos.**

**Paso 5.** Al guardar la versión, los valores finales se persisten en `design_versions.tokensSnapshot`:

```json
{ "--primary-hue": 280, "--radius": 16, "--spacing-scale": 1.2 }
```

### Por qué importa

- **Costo**: ajustes finos no consumen tokens del LLM (puede haber decenas de movimientos del slider).
- **UX**: feedback en 16ms (60fps) en vez de esperar streaming HTTP.
- **Exploración**: el usuario "encuentra" el valor estético sin tener que verbalizarlo perfectamente.
- **Determinismo**: el resultado depende del slider, no de re-rolls del LLM.

### Limitaciones

- Solo aplica a propiedades **modulables** (numéricas/continuas). Cambios estructurales (agregar sección, cambiar layout) sí requieren regenerar.
- El LLM debe haber expuesto los tokens como CSS vars desde el inicio. Si no lo hizo, hay un turn extra para "tokenizar" (refactor del HTML existente para extraer las constantes).
- Los sliders son **por sesión** salvo que se persistan al guardar; si refrescas sin guardar, pierdes los valores.

### Otros tipos de control

El bloque `controls` puede contener más que sliders:

```json
{ "type": "toggle", "var": "--shadow-on", "label": "Sombras", "value": true }
{ "type": "select", "var": "--font-family", "label": "Tipo",
  "options": ["Geist", "Inter", "Serif"], "value": "Geist" }
{ "type": "color", "var": "--accent", "label": "Acento", "value": "#10b981" }
```

Todos siguen el mismo principio: cambian CSS vars, no llaman al LLM.

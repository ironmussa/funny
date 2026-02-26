# Plan: Reduccion de Carga Cognitiva en funny

## Contexto

funny nacio para resolver el dolor de manejar multiples agentes Claude Code en paralelo. Ya tiene Kanban, hilos con estado, review pane, y analytics. El objetivo ahora es **reducir la necesidad de que el usuario "este pendiente" activamente** de sus hilos.

## Diagnostico: Puntos de Friccion

1. **Sin indicadores de tiempo en las respuestas** — Las tarjetas de respuesta del LLM no muestran cuando fueron generadas. El usuario no tiene nocion de cuanto tiempo ha pasado desde la ultima actividad de un hilo.
2. **Decisiones repetitivas por mensaje** — Modelo/modo se deben re-seleccionar en cada follow-up y cada hilo nuevo porque los defaults estan hardcodeados.
3. **El titulo "Threads" en el sidebar no comunica su proposito** — La seccion del sidebar que muestra los ultimos hilos ejecutados y su status se llama genericamente "Threads", lo cual no transmite que es un area de monitoreo de actividad reciente.

---

## Mejora 1: Timestamps Relativos en Tarjetas de Respuesta del LLM

**Problema:** Las tarjetas de respuesta del agente no muestran cuando fueron generadas. El usuario no sabe si una respuesta llego hace 1 minuto o hace 30 minutos, lo cual dificulta entender la linea de tiempo de actividad de un hilo.

**Solucion:** Agregar timestamps relativos ("hace 1 min", "hace 10 min") en cada tarjeta de respuesta del LLM dentro del ThreadView.

### Que se anade:

- En cada tarjeta/burbuja de mensaje del asistente, un texto sutil mostrando el tiempo relativo desde que fue generada (ej: "1m ago", "10m ago", "2h ago")
- El timestamp se actualiza en vivo (cada 60 segundos) para mantenerse relativo
- Estilo discreto (texto pequeno, color muted) para no agregar ruido visual

### Archivos a modificar:

- `packages/client/src/components/ThreadView.tsx` — En el renderizado de mensajes del asistente, agregar el timestamp relativo usando el campo `timestamp` que ya existe en cada mensaje.
- Posiblemente reutilizar la funcion `timeAgo` de `packages/client/src/lib/thread-utils.ts` que ya se usa en el sidebar.

### Impacto: El usuario entiende la linea de tiempo de actividad de cada hilo sin necesidad de calcular mentalmente cuando sucedieron las cosas.

---

## Mejora 2: Defaults Inteligentes (Eliminar Re-seleccion)

**Problema:** Cada hilo nuevo arranca con `opus` + `autoEdit` hardcodeado. El usuario que prefiere otra cosa debe cambiarlo cada vez.

**Solucion:** Defaults configurables que se persisten en los settings generales de la app.

### Que se modifica:

- `packages/client/src/stores/settings-store.ts` — Anadir `defaultModel: 'sonnet' | 'opus' | 'haiku'` y `defaultPermissionMode: string` al store (ya tiene `defaultThreadMode`). Persistidos en localStorage via Zustand persist.
- `packages/client/src/components/PromptInput.tsx` — Cambiar `useState<string>('opus')` -> `useState<string>(defaultModel)` leyendo del settings store. Igual para mode.
- `packages/client/src/components/NewThreadDialog.tsx` — Leer defaults del settings store en vez de hardcodear.
- Seccion en Settings generales para configurar modelo y modo por defecto.

### Impacto: El usuario configura una vez, aplica siempre. Elimina una decision repetitiva por cada hilo/mensaje.

---

## Mejora 3: Renombrar Seccion de Threads en Sidebar

**Problema:** La seccion del sidebar izquierdo que muestra los ultimos hilos ejecutados y su status se llama "Threads". Este nombre es generico y no comunica que su proposito es monitorear la actividad reciente de los agentes.

**Solucion:** Cambiar el titulo a algo que mejor represente su funcion de monitoreo/actividad.

### Opciones de nombre:

- "Activity" — Comunica que es un feed de actividad reciente
- "Recent Activity" — Mas descriptivo
- "Agent Activity" — Especifico al contexto de agentes
- Otra sugerencia del usuario

### Archivos a modificar:

- `packages/client/src/components/sidebar/ThreadList.tsx` o el componente padre que renderiza el header de esta seccion
- Archivos de traduccion si existen (i18n)

### Impacto: El nombre de la seccion comunica inmediatamente su proposito, reduciendo la ambiguedad sobre para que sirve esa area.

---

## Orden de Implementacion Sugerido

| #   | Mejora                     | Esfuerzo | Impacto |
| --- | -------------------------- | -------- | ------- |
| 1   | Timestamps en Tarjetas LLM | Bajo     | Medio   |
| 2   | Defaults Inteligentes      | Muy Bajo | Medio   |
| 3   | Renombrar Seccion Sidebar  | Muy Bajo | Bajo    |

Las 3 mejoras son independientes y pueden implementarse en paralelo.

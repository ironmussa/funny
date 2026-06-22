# Virtualizacion del hilo de conversacion

Este documento explica como funciona hoy la virtualizacion del hilo (la vista de
mensajes de un thread/conversacion) y enumera los edge cases que otro agente debe
tener presentes antes de tocar el codigo.

> Nota de alcance: en el repo tambien existe `VirtualThreadList`, que virtualiza
> listas de threads en `/list`, mobile y settings. Esa implementacion es mucho
> mas simple y esta resumida al final. El flujo complejo, y el que suele causar
> bugs de scroll, es `MessageStream` + `MemoizedMessageList`.

## Archivos principales

- `packages/client/src/components/thread/MessageStream.tsx`
  - Es el scroller real.
  - Maneja sticky-bottom, restauracion por thread, paginacion, phantoms y footer
    sticky.
- `packages/client/src/components/thread/MemoizedMessageList.tsx`
  - Es la lista virtualizada de filas cargadas.
  - Usa `@tanstack/react-virtual`.
  - Convierte mensajes/eventos/tool-calls en filas absolutas.
- `packages/client/src/lib/render-items.ts`
  - Aplana y agrupa mensajes, tool calls y eventos antes de virtualizarlos.
- `packages/client/src/lib/thread-scroll-position.ts`
  - Persiste en `localStorage` el progreso vertical por thread.
- `packages/client/src/machines/thread-data-machine.ts`
  - Al cargar un thread envia `messageProgress` al server para pedir una ventana
    inicial cercana a la ultima posicion guardada.
- `packages/client/src/stores/thread-store.ts`
  - `loadOlderMessages`, `loadNewerMessages`, `loadMessagesUntil` extienden la
    ventana de mensajes cargados.
- `packages/shared/src/repositories/message-repository.ts`
  - Define la semantica de `messageLimit`, `hasMore`, `hasMoreAfter`, `total` y
    `windowStart`.

## Modelo mental rapido

La UI no virtualiza todo el historial real de la base de datos. Hace dos cosas a
la vez:

1. El cliente carga una ventana de mensajes reales, normalmente 50.
2. Dentro de esa ventana, `MemoizedMessageList` virtualiza solo las filas
   renderizables cargadas.
3. Los mensajes no cargados se representan con spacers artificiales
   (`phantomHeight` arriba y `bottomPhantomHeight` abajo) para que el scrollbar
   parezca tener el tamano del historial completo.

Por eso hay dos capas distintas:

```text
Base de datos completa
  -> ventana cargada en Zustand (messages + windowStart + total)
    -> render items agrupados (mensajes, tools, eventos)
      -> virtual rows cargadas (TanStack Virtual)
        -> DOM visible + overscan
```

## Carga inicial y ventana de mensajes

### Server / repository

Cuando el cliente pide un thread con `messageLimit=50`, el repository no manda
todo el historial. Manda una ventana en orden ascendente por timestamp.

- Si no hay progreso guardado, `messageProgress` se asume como `1` y se carga la
  parte final del thread.
- Si hay progreso guardado (`0..1`), se calcula:

```text
maxStart = max(0, total - messageLimit)
windowStart = round(maxStart * messageProgress)
```

El resultado incluye:

- `messages`: mensajes cargados, oldest-first.
- `total`: total real de mensajes del thread.
- `windowStart`: cantidad de mensajes reales antes de la ventana cargada.
- `hasMore`: `true` si hay mensajes antes de la ventana.
- `hasMoreAfter`: `true` si hay mensajes despues de la ventana.
- `lastUserMessage`: ultimo mensaje de usuario, incluso si esta fuera de la
  ventana.

### Client / store

`threadDataMachine` lee `loadThreadScrollProgress(threadId)` y lo manda como
`messageProgress` en `api.getThread(threadId, 50, ..., { messageProgress })`.

El store hidrata el thread con:

- `hasMore`
- `hasMoreAfter`
- `totalMessages`
- `windowStart`
- `messages`
- `threadEvents`
- `compactionEvents`

`ThreadConversation` pasa esos datos a `MessageStream` como `pagination` solo en
la vista principal (`enablePagination`). En mobile se pasa paginacion mas simple,
normalmente solo hacia arriba.

## Estructura DOM de `MessageStream`

El scroller es el `div` raiz de `MessageStream`:

```text
scroll viewport (overflow-y-auto, overflowAnchor none)
  grow spacer                  // empuja contenido al fondo en threads cortos
  contentStack
    top phantom spacer         // mensajes antiguos no cargados
    loading older indicator
    beginning marker
    init info card
    listWrapper
      MemoizedMessageList      // filas virtuales de mensajes cargados
    status tail                // running/waiting/result cards
    prompt pin spacer          // hoy practicamente inerte; ver edge cases
    bottom phantom spacer      // mensajes nuevos no cargados si hasMoreAfter
  sticky bottom dock
    scroll-to-bottom button
    footer / PromptInput
```

Detalles importantes:

- `overflowAnchor: 'none'` desactiva el scroll anchoring nativo de Chrome.
  El codigo intenta controlar todos los ajustes de `scrollTop` manualmente.
- `overscrollBehaviorY: 'contain'` evita que el scroll encadene al body.
- El footer (`PromptInput`) esta fuera del flujo normal como sticky bottom. Los
  calculos de scroll deben evitar mostrar espacio vacio encima del footer.

## Construccion de filas renderizables

`MemoizedMessageList` no recibe filas ya listas. Primero llama
`buildGroupedRenderItems(messages, threadEvents, compactionEvents)`.

### Reglas de `render-items.ts`

- Mensajes sin texto (`content.trim()` vacio) no crean burbuja de mensaje.
- `Think` se emite antes del texto del assistant.
- `EnterPlanMode` se ignora.
- `ExitPlanMode` usa el contenido del plan escrito por un `Write` anterior, o el
  contenido del mensaje assistant, y evita renderizar la burbuja normal.
- Tool calls con `parentToolCallId` no se renderizan como filas separadas; se
  adjuntan a su parent `Task`/`Agent`.
- Tool calls consecutivos con el mismo nombre se agrupan, excepto:
  - `AskUserQuestion`
  - `ExitPlanMode`
- Tool calls consecutivos se compactan en `toolcall-run`.
- `TodoWrite` se deduplica: solo queda el ultimo item relevante.
- `threadEvents` y `compactionEvents` se intercalan cronologicamente.
- `git:changed`, `compact_boundary` y `changed_files_summary` no se renderizan
  como event cards normales.
- Eventos con `workflowId` se agrupan como `workflow-event-group`.

### Reglas extra de `MemoizedMessageList`

Despues de `groupedItems`, se construyen `virtualRows`:

- Cada `RenderItem` se vuelve una fila `{ type: 'item', key, item, itemIndex }`.
- Tambien se inyectan filas `{ type: 'session-summary' }` al final de cada
  sesion de usuario si `sessionChanges` tiene cambios para ese user message.
- La ultima `session-summary` se marca `isLastSection` para deshabilitar revert
  mientras el agente sigue corriendo.

Keys importantes:

- Mensaje: `msg.id`
- Tool call: `tc.id`
- Tool group/run: id del primer call del grupo/run
- Thread event: `event.id`
- Compaction: `compact-${timestamp}`
- Workflow group: `workflow-${firstEventId}`
- Session summary: `session-summary-${userMessageId}`

## Virtualizacion con TanStack Virtual

`MemoizedMessageList` crea `rowVirtualizer` con:

- `count = virtualRows.length`
- `getScrollElement = scrollRef.current` (el scroller de `MessageStream`)
- `getItemKey(index) = virtualRows[index].key`
- `gap = 16px`
- `overscan = 8`
- `scrollMargin = listScrollMargin`
- `measureElement` custom para cachear altura real por key.

El contenedor de filas tiene:

```text
height: rowVirtualizer.getTotalSize()
position: relative
overflowAnchor: none
```

Cada fila virtual visible se renderiza como:

```text
position: absolute
top: 0
left: 0
width: 100%
transform: translateY(virtualItem.start - listScrollMargin)
```

### `listScrollMargin`

TanStack Virtual necesita saber que la lista no empieza en `scrollTop=0` del
viewport porque antes hay spacers, init cards, markers, etc.

`listScrollMargin` se calcula como:

```text
containerRect.top - viewportRect.top + viewport.scrollTop
```

Se actualiza con:

- `useLayoutEffect` en cada commit.
- `ResizeObserver` sobre viewport, container, parent y content stack.
- `MutationObserver` sobre content stack.
- evento `scroll` del viewport.
- `requestAnimationFrame` para no medir en medio del layout.

Si este valor se queda viejo, los sintomas tipicos son filas desplazadas,
sticky section incorrecto, clicks en la seccion de usuario que no alinean bien o
scroll-to-index que cae fuera de lugar.

## Estimacion y medicion de alturas

Cada fila tiene una altura estimada hasta que el DOM real se mide.

### Estimaciones

- User message: `80px`
- Assistant message: intenta usar pretext si:
  - hay contenido,
  - `containerWidth > 100`,
  - `isPretextReady()`,
  - existe cache preparada.
- Assistant fallback: `120px`
- Tool call / group: `44px`
- Tool run: `44px * item.items.length`
- Thread event / compaction / workflow event: `32px`
- Session summary: `72px`
- Fallback: `60px`

### Medicion real

`measureElement` usa, en orden:

1. `ResizeObserverEntry.borderBoxSize.blockSize`, si existe.
2. `element.getBoundingClientRect().height`.

Si la altura es positiva, se guarda en `heightCache` por `data-virtual-row-key`.

El cache se borra cuando cambia el `layoutKey`:

```text
threadId:globalFontSize:round(containerWidth)
```

Tambien se fuerza `rowVirtualizer.measure()` en `useLayoutEffect` y en dos RAFs
posteriores cuando cambian `containerWidth`, `globalFontSize`, `threadId` o
`virtualRows`.

## Pretext warm-up

Para mensajes assistant largos se intenta preparar mediciones de texto en
background:

- Se difiere con `requestIdleCallback` o `setTimeout(0)`.
- Primero carga pretext con `ensurePretextLoaded()`.
- Luego analiza markdown, extrae texto plano y llama `prepareBatch` para textos
  no cacheados.

Esto mejora la estimacion inicial, pero no reemplaza la medicion real por
`ResizeObserver`.

## Sticky bottom y restauracion de scroll

`MessageStream` guarda por thread:

```ts
{
  scrollProgress: number, // 0..1
  atBottom: boolean,
  userHasScrolledUp: boolean,
}
```

Hay dos capas:

- Memoria local del componente (`threadScrollPositionsRef`).
- Persistencia en `localStorage` via `funny.threadScrollProgress.v1`.

La distancia al fondo se define como:

```text
scrollHeight - scrollTop - clientHeight
```

`atBottom` es true si esa distancia es `<= 80px`.

### Al cambiar de thread

Se resetean referencias internas:

- `prevOldestIdRef`
- `prevScrollHeightRef`
- `prevStickyMetricsRef`
- `pinnedPromptIdRef`
- `promptPinSpacerHeight`
- `prevLastUserMessageIdRef`
- `prevWaitingReasonRef`

Luego `applyThreadScrollPosition` corre inmediatamente y en dos RAFs.

Si no hay posicion guardada o estaba en bottom:

```text
scrollTop = scrollHeight
userHasScrolledUp = false
```

Si habia posicion no-bottom:

```text
maxScrollTop = scrollHeight - clientHeight
scrollTop = saved.scrollProgress * maxScrollTop
userHasScrolledUp = saved.userHasScrolledUp
```

Esto restaura por porcentaje, no por id de mensaje. Si la altura total cambia,
la posicion visual puede moverse aunque el progreso sea el mismo.

### Mientras stream agrega contenido

En cada layout relevante:

- Si hay nuevo user message, se fuerza bottom.
- Si aparece waiting reason `question` o `permission`, se hace scroll smooth al
  bottom.
- Si el usuario no ha scrolleado hacia arriba y el viewport estaba pinned antes
  del cambio, se vuelve a pinnear al bottom.
- Si el usuario scrolleo hacia arriba, no se fuerza el scroll.

`pinViewportToBottom` hace `scrollTop = scrollHeight` ahora, luego en RAF, luego
en otro RAF. Esto cubre cambios de altura tardios por render/medicion.

## Phantoms de paginacion

`MessageStream` calcula cuantos mensajes reales faltan alrededor de la ventana:

```text
unloadedBeforeCount = hasMore ? windowStart : 0
unloadedAfterCount = hasMoreAfter ? total - windowStart - loadedCount : 0
```

Luego estima altura promedio:

```text
avg = listWrapper.offsetHeight / loadedCount
avg clamped to [24, 2000]
```

Y crea spacers:

```text
phantomHeight = unloadedBeforeCount * avg
bottomPhantomHeight = unloadedAfterCount * avg
```

Al cambiar de thread se resetean `avgMsgHeightRef`, `phantomHeight` y
`bottomPhantomHeight`.

### Ajuste cuando cambia el phantom superior

Si `phantomHeight` cambia pero no cambio el primer mensaje (`firstMessageId`),
el contenido real se mueve. El codigo compensa:

- Si estabas pinned al bottom, vuelve a hacer `pinViewportToBottom`.
- Si no, suma `delta` a `scrollTop`.

Si `firstMessageId` cambio, se asume que fue una pagina nueva y la correccion la
hace `restoreScrollAnchor`; por eso se evita doble correccion.

## Paginacion hacia arriba

En `handleViewportScrollRef` se llama `pagination.load()` si:

```text
pagination existe
scrollTop < phantomHeight + 200
hasMore
!loadingMore
!messageListRef.current?.hasHiddenItems()
```

`hasHiddenItems()` devuelve true si el primer item virtual montado tiene indice
mayor que 0. Es una barrera para no pedir pagina antigua mientras aun hay filas
cargadas virtualizadas por encima de la zona visible.

Antes de pedir pagina:

1. `captureScrollAnchor()` guarda la primera fila DOM cuyo bottom esta por debajo
   del top del viewport.
2. `loadOlderMessages()` trae mensajes antes del timestamp del primer mensaje.
3. El store deduplica por id y prepende los nuevos mensajes.
4. Cuando cambia `firstMessageId`, `MessageStream` llama
   `restoreScrollAnchor()`.

`restoreScrollAnchor()`:

- Si la fila ancla sigue montada, mide el drift visual y suma ese drift a
  `scrollTop`.
- Si no esta montada pero su key existe en `rowKeyIndexMap`, hace
  `scrollToIndex(index, { align: 'start' })` y en el siguiente RAF aplica drift.
- Si la key ya no existe, cancela el anchor.

## Paginacion hacia abajo

Si la ventana inicial no esta al final (`hasMoreAfter=true`), se puede cargar
hacia abajo con `loadAfter` si:

```text
pagination.loadAfter existe
hasMoreAfter
!loadingMore
scrollTop + clientHeight > scrollHeight - bottomPhantomHeight - 200
```

`loadNewerMessages()` pide mensajes despues del timestamp del ultimo mensaje y
los append-ea. No usa el mecanismo de scroll anchor; depende de estar cerca del
bottom y de la contraccion de `bottomPhantomHeight`.

## Sticky section context

La UI duplica el user message de la seccion actual como una cabecera sticky
cuando el dueno de la seccion no esta claramente visible.

La cabecera sticky:

- Se renderiza con `z-50` y `h-0`.
- No incluye `data-item-key`.
- No incluye `data-user-msg`.
- Si se hace click, busca la fila real con `data-section-msg-id` y hace scroll
  hacia esa seccion, pero clamp-ea para no exponer espacio vacio sobre el prompt
  sticky.

## API imperativa usada por search/timeline

`MessageStreamHandle` expone:

- `scrollToBottom()`
- `scrollViewport`
- `expandToItem(id)`
- `hasHiddenItems()`
- `captureScrollAnchor()`
- `restoreScrollAnchor()`

`expandToItem(id)` usa un mapa de id -> virtual index. Incluye mensajes, tool
calls dentro de grupos/runs, thread events y workflow events.

La timeline/search primero intentan encontrar el DOM real. Si no existe porque
la fila no esta montada, llaman `expandToItem` y en un RAF vuelven a buscar.

## Invariantes que deben mantenerse

1. El array `messages` siempre debe estar en orden ascendente por timestamp.
2. `windowStart` debe representar cuantos mensajes reales hay antes de
   `messages[0]`.
3. `totalMessages` debe ser el total real, no el total cargado.
4. `hasMore` y `hasMoreAfter` deben estar alineados con `windowStart`,
   `loadedCount` y `totalMessages`.
5. Las keys de `virtualRows` deben ser estables mientras la entidad sea la misma.
6. Una fila con la misma key pero contenido/altura nueva debe terminar siendo
   re-medida.
7. El scroller real es el root de `MessageStream`; no crear otro overflow parent
   alrededor sin revisar `getScrollElement`, `listScrollMargin` y observers.
8. No reactivar scroll anchoring nativo en el viewport ni en filas principales.
9. Cualquier elemento arriba de `MemoizedMessageList` debe disparar actualizacion
   de `listScrollMargin` cuando cambie de alto.
10. Si se agrega un nuevo tipo de fila, debe tener key estable, estimacion de
    altura y reglas para `buildRenderItemIdIndexMap` si search/timeline deben
    navegarlo.

## Edge cases conocidos

### Threads vacios o cortos

- Si `messages.length === 0`, `loadedCount=0`; no se recalcula promedio desde el
  wrapper.
- El `grow` spacer empuja contenido corto al fondo.
- `getScrollProgress` devuelve `1` cuando no hay rango scrolleable.

### Restauracion entre threads de alturas distintas

- Bottom se guarda como progreso `1` y se restaura con `scrollTop=scrollHeight`.
- No-bottom se guarda como porcentaje. Si el contenido cambia de altura, se
  vuelve a una altura proporcional, no al mismo mensaje.

### Streaming con mensaje assistant que crece

- Si estabas pinned al bottom, el viewport debe seguir pinned mientras el
  contenido crece.
- Si el usuario scrolleo hacia arriba, no debe forzarse al bottom.
- Se quito `contentVisibility:auto` de mensajes y tool rows variables porque
  Chrome podia quedarse con una burbuja vacia cuando el mismo msg id pasaba de
  placeholder vacio a contenido real.

### Cache de altura con misma key

- El cache se borra por thread/font/width, no necesariamente por cambio de
  contenido de la misma key.
- Si una fila medida cambia mucho de contenido estando desmontada, el cache puede
  seguir usando una altura vieja hasta que esa fila vuelva a montarse y medirse.
- Este es un punto sospechoso si el bug es scrollbar incorrecto despues de
  streaming offscreen o cambios en tool cards ya virtualizadas.

### Imagenes, markdown y codigo

- La estimacion pretext no contempla imagenes cargando tarde.
- `ResizeObserver` debe corregir la altura real cuando imagenes/codigo cambian.
- Si el browser no emite ResizeObserver por algun cambio visual, el total size
  puede quedar viejo.

### Tool calls agrupados y deduplicados

- `TodoWrite` puede desaparecer excepto el ultimo; anchors/search a un TodoWrite
  viejo pueden no tener fila.
- Un tool call dentro de `toolcall-group` o `toolcall-run` mapea al index del
  grupo/run, no a una subfila independiente.
- `AskUserQuestion` y `ExitPlanMode` no se agrupan para no romper botones de
  respuesta/interaccion.

### Eventos y session summaries

- `changed_files_summary` no aparece como event card; alimenta `sessionChanges`.
- Una `session-summary` se asocia al user message de la sesion actual.
- Si `sessionChanges` cambia, se agregan/quitan filas y puede cambiar el index de
  muchas filas despues de ese punto.

### Sticky section duplicado

- El sticky user message es un duplicado visual. No debe participar en observers
  de timeline ni en `data-item-key`.
- Como internamente renderiza `UserMessageCard`, puede duplicar atributos de test
  como `data-testid=user-message-...`; cuidado al escribir tests/selectores.
- Clickear el sticky intenta alinear la seccion real, pero si la fila real no
  esta montada o `listScrollMargin` esta viejo, puede no hacer nada o caer mal.

### Paginacion antigua con phantom superior

- El trigger usa `phantomHeight + 200`, no simplemente `200`, porque el phantom
  empuja el contenido real hacia abajo.
- Si `hasHiddenItems()` es true, no carga mas aunque estes cerca del top fisico;
  primero debe estar montada la primera fila virtual de la ventana cargada.
- Si el anchor capturado desaparece por cambios de grouping/dedup/session
  summary, `restoreScrollAnchor` no puede preservar posicion.

### Paginacion nueva con bottom phantom

- `loadAfter` no usa anchor.
- Si el usuario esta en una ventana media y busca/navega a algo despues de la
  ventana, revisar que haya camino para cargar hacia abajo. `loadMessagesUntil`
  actualmente solo pagina hacia mensajes antiguos (`hasMore`), no hacia
  `hasMoreAfter`.

### Busqueda y timeline

- `scrollIntoView` solo funciona si el DOM existe. Para filas virtualizadas se
  usa `expandToItem` y se reintenta en RAF.
- Un RAF puede no bastar si TanStack Virtual necesita mas commits/mediciones.
- Search server-side puede devolver un mensaje no cargado. Se llama
  `loadMessagesUntil`, con limite de 40 paginas de 100.

### LocalStorage / SSR / privacy mode

- `thread-scroll-position.ts` no lanza si `window` no existe o si localStorage
  falla; simplemente usa memoria o ignora persistencia.
- Se guarda solo el numero de progreso, no `userHasScrolledUp`. Al recrear desde
  localStorage, `userHasScrolledUp = progress < 0.999`.

### Multiples instancias del mismo thread

- El mapa en memoria de posiciones vive por instancia de `MessageStream`.
- `localStorage` es global por `threadId`. Dos vistas del mismo thread pueden
  sobrescribir el progreso persistido.
- La grid/live columns no siempre habilitan paginacion; no asumir que todos los
  `MessageStream` pueden cargar paginas.

### Mobile / compact

- En compact/mobile no se usa timeline visible ni prompt pin.
- Mobile pasa paginacion mas limitada; puede no pasar `windowStart` ni
  `hasMoreAfter`. Entonces `MessageStream` deriva `windowStart` como
  `total - loadedCount` cuando `hasMore` es true.

### Prompt pin spacer

- Hay estado `promptPinSpacerHeight` y `pinnedPromptIdRef`, pero en el codigo
  actual no se ve ningun set positivo de `promptPinSpacerHeight`.
- Por ahora parece una ruta inerte/legacy. Si alguien intenta arreglar bugs de
  prompt pin, primero confirmar si falta codigo o si debe eliminarse.

### Comparator memoizado

- `MemoizedMessageList` usa comparator custom.
- Solo re-renderiza si cambian refs/props especificas.
- `threadStatus` se compara como booleano `(status === 'waiting')`, no por valor
  exacto, porque solo importa mostrar botones de respuesta en cards.
- `knownIds` y `prefersReducedMotion` se reciben como `_knownIds` y
  `_prefersReducedMotion`; hoy no se usan. Si se vuelven a usar, el comparator
  debe actualizarse.

## Checklist para debuggear bugs de virtualizacion

1. Confirmar si el bug es de:
   - ventana server/store (`messages`, `windowStart`, `hasMore`, `total`),
   - phantoms (`phantomHeight`, `bottomPhantomHeight`),
   - TanStack Virtual (`virtualRows`, `getTotalSize`, `virtualItems`),
   - medicion (`heightCache`, `measureElement`),
   - restauracion (`scrollTop`, anchors, sticky bottom).
2. Loggear por thread:
   - `threadId`
   - `messages.length`
   - `totalMessages`
   - `windowStart`
   - `hasMore` / `hasMoreAfter`
   - `phantomHeight` / `bottomPhantomHeight`
   - `scrollTop`, `scrollHeight`, `clientHeight`
   - `userHasScrolledUp.current`
   - primer/ultimo `virtualItem.index`
3. Verificar si `listScrollMargin` coincide con la distancia real desde top del
   viewport hasta `MemoizedMessageList`.
4. Revisar si la fila problematica tiene key estable y si su altura cacheada
   corresponde al DOM real.
5. Si falla al paginar hacia arriba, revisar que se capture anchor antes de
   cambiar `messages` y que la key exista despues del prepend.
6. Si falla al buscar/timeline, revisar si el id mapea a una fila agrupada o fue
   deduplicado/omitido.
7. Si solo falla cuando el agente stream-ea, revisar cache de altura para filas
   con misma key y contenido nuevo.
8. Si solo falla al cambiar de thread, revisar localStorage
   `funny.threadScrollProgress.v1` y el `messageProgress` enviado al server.

## Tests existentes que documentan comportamiento

- `packages/client/src/__tests__/components/MemoizedMessageList.test.tsx`
  - Mantiene acotadas las filas montadas en threads largos.
  - No cuenta el sticky section context como fila medida.
  - Muestra sticky context cuando el owner esta montado solo por overscan.
  - No usa `content-visibility` en tool rows variables.
  - Usa `borderBoxSize` de ResizeObserver para medir filas.
- `packages/client/src/__tests__/components/MessageStream.test.tsx`
  - Aisla el scroller del browser anchoring y overscroll chaining.
  - Mantiene bottom pinned mientras crece contenido stream-eado.
  - No fuerza scroll si el viewport ya no esta pinned.
  - Restaura bottom/non-bottom entre threads largos/cortos.
  - Restaura no-bottom por progreso cuando cambia la altura total.
- `packages/client/src/__tests__/stores/thread-store-actions.test.ts`
  - Cubre `loadOlderMessages` y `loadMessagesUntil`.
- `packages/shared/src/__tests__/repositories/message-repository.test.ts`
  - Cubre `messageLimit`, `hasMore`, `hasMoreAfter` y `windowStart`.

## Mini-resumen de `VirtualThreadList`

Si el bug reportado no es la conversacion sino la lista de threads, el archivo es
`packages/client/src/components/VirtualThreadList.tsx`.

Esa lista:

- Recibe `threads: Thread[]` ya filtrados/ordenados por el caller.
- Usa `useVirtualizer` con:
  - `count = threads.length`
  - `estimateSize = 60`
  - `getItemKey = thread.id`
  - `overscan = 10`
- Renderiza un scroll container propio con un inner div de
  `height = virtualizer.getTotalSize()`.
- Cada row es `position:absolute` con `translateY(v.start)`.
- Usa `measureElement` para rows, asi que snippets/badges que cambian altura
  deberian medirse al estar montados.
- `LOAD_MORE_THRESHOLD = 5`: si el ultimo virtual item visible esta a 5 del final
  y `hasMore && !loadingMore`, llama `onEndReached()`.
- Soporta keyboard navigation desde el search input via `onSearchKeyDownRef`:
  - ArrowDown/ArrowUp cambia `highlightIndex` y hace `scrollToIndex`.
  - Enter llama `onThreadClick(threads[highlightIndex])`.
- `highlightIndex` se resetea a `-1` cuando cambia `search` o `threads`.

Edge cases especificos de `VirtualThreadList`:

- Si `threads.length === 0`, no hay scroll container; se renderiza un empty state.
- Si `threads` cambia identidad frecuentemente, se resetea el highlight.
- Si un row cambia de alto estando desmontado, TanStack puede usar estimacion
  hasta que se monte y mida.
- El loading spinner esta fuera del inner div virtualizado; no forma parte de
  `getTotalSize()`.
- `onEndReached` puede dispararse varias veces si el caller no pone
  `loadingMore=true` mientras carga.
- El mouse move sobre una row cambia `highlightIndex`, lo cual puede interferir
  con navegacion por teclado si el puntero esta sobre la lista.

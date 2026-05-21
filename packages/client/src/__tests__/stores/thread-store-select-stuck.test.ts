/**
 * Reproducción del bug observado en Abbacchio (11 warnings "invariant re-select"
 * en sesiones recientes): la URL cambia al hilo B pero el store sigue en A.
 *
 * Hipótesis: `selectingThreadId` se queda "colgado" porque en
 * `thread-store.ts:481` se setea ANTES del bloque try/finally. Si algo entre
 * esa línea y la 528 throwa (un set, un listener, telemetría, eviction),
 * `selectingThreadId` nunca se limpia y cualquier `selectThread(B)` posterior
 * se short-circuita en la línea 478.
 *
 * Este test reproduce el síntoma directamente sin requerir que algo throwe:
 * pre-condiciona `selectingThreadId = B` y demuestra que `selectThread(B)`
 * es un no-op aunque no haya fetch en vuelo.
 */
import { okAsync } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

const { mockGetThread, mockGetThreadEvents, mockListThreads, mockStartSpan } = vi.hoisted(() => ({
  mockGetThread: vi.fn(),
  mockGetThreadEvents: vi.fn(),
  mockListThreads: vi.fn(),
  mockStartSpan: vi.fn(),
}));

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    sendMessage: vi.fn(),
    stopThread: vi.fn(),
    approveTool: vi.fn(),
    searchThreadContent: vi.fn(),
    getThread: mockGetThread,
    getThreadEvents: mockGetThreadEvents,
    listThreads: mockListThreads,
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    archiveThread: vi.fn(),
    getThreadMessages: vi.fn(),
    renameThread: vi.fn(),
    pinThread: vi.fn(),
    updateThreadStage: vi.fn(),
  },
}));

vi.mock('@/stores/store-bridge', () => ({
  expandProject: vi.fn(),
  selectProject: vi.fn(),
  getProjectPath: vi.fn(),
  registerThreadStore: vi.fn(),
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ selectProject: vi.fn() }), subscribe: vi.fn() },
}));

vi.mock('@/lib/telemetry', () => ({
  startSpan: mockStartSpan,
  metric: vi.fn(),
}));

vi.mock('@/stores/thread-ws-handlers', () => ({
  handleWSInit: vi.fn(),
  handleWSMessage: vi.fn(),
  handleWSToolCall: vi.fn(),
  handleWSToolOutput: vi.fn(),
  handleWSStatus: vi.fn(),
  handleWSError: vi.fn(),
  handleWSResult: vi.fn(),
  handleWSQueueUpdate: vi.fn(),
  handleWSCompactBoundary: vi.fn(),
  handleWSContextUsage: vi.fn(),
}));

// IMPORTANTE: NO mockear @/stores/thread-store-internals — necesitamos los
// internals reales para que `getSelectingThreadId` / `nextSelectGeneration`
// se comporten exactamente como en producción.

import { useThreadStore } from '@/stores/thread-store';
import {
  setSelectingThreadId,
  getSelectingThreadId,
  setThreadSelectListener,
} from '@/stores/thread-store-internals';

const threadA = {
  id: 'thread-A',
  projectId: 'proj-1',
  title: 'A',
  status: 'completed',
  cost: 0,
  messages: [],
  threadEvents: [],
  hasMore: false,
};

const threadB = {
  id: 'thread-B',
  projectId: 'proj-1',
  title: 'B',
  status: 'completed',
  cost: 0,
  messages: [],
  threadEvents: [],
  hasMore: false,
};

describe('selectThread — stuck selectingThreadId (reproduces "invariant re-select" bug)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default startSpan implementation — returns a no-op handle. Individual
    // tests can override with `mockImplementationOnce` to simulate failures.
    mockStartSpan.mockImplementation(() => ({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-00`,
      end: () => {},
    }));
    // `loadThreadsForProject` se dispara dentro de selectThread cuando el
    // proyecto no tiene su lista de hilos cargada; devolver okAsync vacío
    // evita una unhandled rejection ortogonal al bug bajo prueba.
    mockListThreads.mockReturnValue(okAsync({ threads: [], total: 0 }));
    // Reset el estado del store a un punto conocido: hilo A activo, B no cargado.
    useThreadStore.setState({
      selectedThreadId: threadA.id,
      activeThread: { ...threadA } as any,
      threadDataById: { [threadA.id]: { ...threadA } as any },
      threadsById: {},
      threadIdsByProject: {},
      scratchThreadIds: [],
    });
    // Asegurar que los internals están limpios entre tests.
    setSelectingThreadId(null);
  });

  test('repro: selectThread(B) es no-op cuando selectingThreadId está colgado en B', async () => {
    // Simular el estado "post-throw" descrito en thread-store.ts:481-528:
    // `setSelectingThreadId` fue llamado pero el try/finally que lo limpia
    // nunca corrió porque algo posterior throweó (set listener, telemetría,
    // _evictIfUnreferenced, etc.).
    setSelectingThreadId(threadB.id);
    expect(getSelectingThreadId()).toBe(threadB.id);

    // Usuario hace click en hilo B en el sidebar → navigate(/threads/B) →
    // useRouteSync detecta el cambio de URL → llama selectThread(B).
    mockGetThread.mockReturnValue(okAsync(threadB));
    mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));

    await useThreadStore.getState().selectThread(threadB.id);

    // BUG: la línea 478 de thread-store.ts hace short-circuit:
    //   if (threadId && threadId === getSelectingThreadId()) return;
    // Como no entró al cuerpo de la función, ni siquiera se intentó la
    // hidratación. El store queda en A.
    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(threadA.id);
    expect(state.activeThread?.id).toBe(threadA.id);

    // Y `selectingThreadId` sigue colgado — cualquier intento futuro de
    // seleccionar B (incluido el "invariant re-select" guard de route-sync)
    // también será no-op.
    expect(getSelectingThreadId()).toBe(threadB.id);

    // Confirmar que el fetch nunca se disparó.
    expect(mockGetThread).not.toHaveBeenCalled();
  });

  test('regresión: si notifyThreadSelected throwa, selectingThreadId se limpia igual', async () => {
    // Reproduce la causa raíz: cualquier throw entre `setSelectingThreadId`
    // y el `try` del fetch (línea 528) dejaba selectingThreadId colgado.
    // Con el fix (try/finally envolvente), el cleanup corre siempre.
    setThreadSelectListener(() => {
      throw new Error('simulated listener failure');
    });

    mockGetThread.mockReturnValue(okAsync(threadB));
    mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));

    await expect(useThreadStore.getState().selectThread(threadB.id)).rejects.toThrow(
      'simulated listener failure',
    );

    // El throw NO debe dejar selectingThreadId colgado — si lo hiciera, el
    // próximo click a B sería no-op (el bug original).
    expect(getSelectingThreadId()).toBeNull();

    // Limpiar el listener para que no contamine el próximo test.
    setThreadSelectListener(() => {});
  });

  test('regresión: si startSpan throwa, selectingThreadId no queda colgado', async () => {
    // startSpan corre ANTES del try/finally — si throwa, el slot in-flight
    // se quedaría colgado y bloquearía toda selección futura del mismo hilo.
    // El fix mueve `setSelectingThreadId` DESPUÉS de startSpan para que un
    // throw aquí ni siquiera reclame el slot.
    mockStartSpan.mockImplementationOnce(() => {
      throw new Error('telemetry transport down');
    });

    mockGetThread.mockReturnValue(okAsync(threadB));
    mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));

    await expect(useThreadStore.getState().selectThread(threadB.id)).rejects.toThrow(
      'telemetry transport down',
    );

    // Sin esto, el próximo click a B sería un no-op (el bug que el usuario
    // ve como "la URL cambia pero el panel derecho se queda igual").
    expect(getSelectingThreadId()).toBeNull();

    // El fetch nunca debió dispararse porque el throw fue antes del try.
    expect(mockGetThread).not.toHaveBeenCalled();
  });

  test('regresión: back-fill subscriber no debe revertir selectedThreadId durante keepStale', async () => {
    // Repro del bug "URL cambia pero el panel derecho se queda igual".
    //
    // Setup: usuario en A, hace click en B, pero B ya tiene su data actor en
    // estado `loaded` (cacheHit=true) — esto activa el path `keepStale` que
    // deliberadamente deja `activeThread=A` mientras `selectedThreadId=B`,
    // para que el panel derecho no parpadee mientras carga B.
    //
    // El bug: justo después del set() de selectThread, `_evictIfUnreferenced(A)`
    // sacaba A de `threadDataById`. El subscriber de back-fill veía
    // "activeThread=A pero threadDataById[A]=undefined", reinjectaba A en el
    // mapa Y forzaba `selectedThreadId=A`. El usuario terminaba con URL=/B y
    // el panel mostrando A.
    //
    // Para forzar el path keepStale precargamos B en el data-machine actor:
    // disparamos un prefetch y esperamos a que el actor llegue a `loaded`
    // con la data mockeada. En ese punto `isThreadDataLoaded(B)` devuelve
    // true y `selectThread` toma el branch `keepStale`.
    mockGetThread.mockReturnValue(okAsync(threadB));
    mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));
    useThreadStore.getState().prefetchThread(threadB.id);
    await new Promise((r) => setTimeout(r, 10));

    await useThreadStore.getState().selectThread(threadB.id);

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(threadB.id);
    // El panel derecho debe terminar mostrando B, no A.
    expect(state.activeThread?.id).toBe(threadB.id);
    expect(state.threadDataById[threadB.id]).toBeTruthy();
  });

  test('control: con selectingThreadId limpio, selectThread(B) sí actualiza el store', async () => {
    // Sanity check: el mismo flujo, pero con selectingThreadId en null,
    // demuestra que el path normal sí funciona y que el bug del test
    // anterior es específicamente la condición "colgado".
    expect(getSelectingThreadId()).toBeNull();

    mockGetThread.mockReturnValue(okAsync(threadB));
    mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));

    await useThreadStore.getState().selectThread(threadB.id);

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(threadB.id);
    expect(state.activeThread?.id).toBe(threadB.id);
    expect(getSelectingThreadId()).toBeNull();
  });
});

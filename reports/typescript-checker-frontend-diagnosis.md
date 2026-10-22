# Frontend: diagnóstico de Bun frente a tsrs

Medido en el commit c404f4b04, Bun 1.4.3 y tsrs 0.18.0-ts7.1.0-dev.20260929; Linux x64, 20 CPU lógicas. Una ronda de calentamiento descartada y tres rondas medidas, ejecución secuencial, alternando el orden de herramientas. Tiempo de pared incluye arranque; memoria es mediana del RSS pico por invocación de GNU time. Cachés del sistema calientes; no se vació la caché de disco. Se activaron estadísticas internas en ambos compiladores.

## Frontend completo

| Workers solicitados | Bun segundos | tsrs segundos | Bun MiB | tsrs MiB |
| ------------------- | -----------: | ------------: | ------: | -------: |
| Predeterminados     |        1.626 |         2.227 |   653.0 |    723.4 |
| 1                   |        3.122 |         2.882 |   528.0 |    429.4 |
| 4                   |        1.678 |         2.280 |   462.4 |    539.2 |
| 8                   |        1.450 |         2.267 |   533.7 |    607.9 |
| 20                  |        1.698 |         2.294 |   653.0 |    758.7 |

Se solicitó el mismo número mediante `bun check --threads N` y `tsrs --checkers N`. Esto iguala el parámetro de concurrencia, no garantiza una arquitectura de hilos idéntica: tsrs distingue checkers de la carga/parsing. Todos los runs completos terminaron sin errores.

## Fases con 4 workers

| Herramienta | Carga / parse y resolución (s) | Check (s) |
| ----------- | -----------------------------: | --------: |
| bun         |                          0.871 |     0.759 |
| tsrs        |                          1.705 |     0.421 |

Ambos cargaron 7.028 archivos en el frontend completo. Las fases reportadas por cada herramienta son orientativas y no tienen necesariamente límites internos idénticos.

## Selecciones de archivos, con 4 workers

Cada selección conserva las opciones del frontend y sigue sus imports transitivos. Los grupos se solapan: no representan costos sumables ni dependencias aisladas.

| Selección  | Bun segundos | tsrs segundos | Bun MiB | tsrs MiB |
| ---------- | -----------: | ------------: | ------: | -------: |
| production |        1.354 |         2.152 |   408.6 |    454.2 |
| ui         |        0.605 |         1.151 |   281.7 |    187.9 |
| stores     |        0.530 |         0.413 |   264.9 |    179.2 |
| lib        |        0.590 |         0.604 |   268.7 |    211.4 |
| prompt     |        0.511 |         0.517 |   261.9 |    188.1 |

`production` excluye `__tests__`, `*.test.*`, `*.spec.*`, `*.stories.*` de la selección inicial. Los otros grupos seleccionan `src/components/ui`, `src/stores`, `src/lib` y `src/components/prompt-input`, además de las declaraciones locales `src/**/*.d.ts`.

Al retirar archivos aparecen errores TS2591 sobre `process` en `packages/shared/src/provider-manifest.ts`, idénticos en ubicación y código entre herramientas (el texto sugiere bun/npm respectivamente). UI no presenta errores. Son configuraciones experimentales incompletas, no configuraciones recomendadas para producción. No se cambiaron las configuraciones reales.

## Dependencias aisladas, con 4 workers

Archivo mínimo: `import * as Library from "paquete"; export type PublicAPI = typeof Library;`. Hereda las opciones del frontend, fija `types: []`, y solo incluye ese archivo. Mide carga de las declaraciones públicas y sus imports; no reproduce las instanciaciones del uso real en la app.

| Paquete                | Bun segundos | tsrs segundos | Bun MiB | tsrs MiB |
| ---------------------- | -----------: | ------------: | ------: | -------: |
| react                  |        0.091 |         0.050 |    60.2 |     48.2 |
| lucide-react           |        0.156 |         0.070 |    68.8 |     48.1 |
| @radix-ui/react-select |        0.147 |         0.086 |    58.6 |     48.2 |
| monaco-editor          |        0.106 |         0.047 |    56.7 |     48.3 |
| @storybook/react-vite  |        0.208 |         0.180 |   118.5 |     75.6 |
| @tiptap/react          |        0.105 |         0.071 |    62.7 |     48.2 |
| recharts               |        0.184 |         0.119 |    69.5 |     48.6 |

Códigos de salida en probes: [0].

Los siete imports mínimos favorecieron a tsrs en tiempo y RSS. Esto no identifica una biblioteca culpable; tampoco descarta costos al combinar sus tipos en el código real.

## Interpretación

La desventaja de tiempo del frontend se concentra en cargar y resolver el grafo de archivos, no en que tsrs tarde más verificando tipos. Con un checker tsrs supera a Bun y usa menos memoria; al aumentar checkers suben sus contadores de tipos e instanciaciones y su RSS, mientras la carga del grafo sigue dominando. Esto respalda que el paralelismo aumenta el trabajo/estado de los checkers sin compensar el costo de carga en este proyecto. No es una prueba de un fallo específico de React, Rust o de una biblioteca.

Excluir pruebas y stories reduce el trabajo, pero no elimina la diferencia. Estas mediciones no distinguen todavía dentro de la carga entre filesystem, resolución y parsing; haría falta un perfil interno o un reproductor mínimo para atribuirlo a una implementación concreta.

Referencia de opciones: [documentación de tsrs](https://github.com/oxc-project/tsrs/blob/main/docs/USAGE.md).

Corrección del resumen anterior: en el benchmark original tsrs usaba menos memoria en **12 de 15** proyectos, no 13; las excepciones eran client, runtime y client-gpuix-benchmark.

En tsrs, la mediana de instanciaciones pasó de 1.527.432 con un checker a 4.420.958 con veinte. Su fase de parse se mantuvo cerca de 1,8 segundos.

[Datos de las 136 invocaciones, incluidas las rondas de calentamiento](typescript-checker-frontend-measurements.json).

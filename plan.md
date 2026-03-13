# Plan: Arquitectura Dual-Mode (Local SQLite / Multi PostgreSQL)

## Principio fundamental

```
AUTH_MODE=local  → DB_MODE=sqlite  → Todo en SQLite local (~/.funny/data.db)
AUTH_MODE=multi  → DB_MODE=postgres → Todo en PostgreSQL (DATABASE_URL)
```

**No hay mezcla.** En multi mode, NADA usa SQLite. En local mode, NADA usa PostgreSQL.

## Lo que YA funciona en el server

- `db-mode.ts` detecta `DB_MODE` env var
- `db/index.ts` hace switch SQLite/PG con compat helpers (`dbAll`, `dbGet`, `dbRun`)
- `migrate.ts` tiene migraciones dual-dialect
- `auth.ts` cambia provider `sqlite` ↔ `pg` en Better Auth
- `auth-mode.ts` valida que `multi` requiere `postgres`
- Todos los services usan los compat helpers

## Gaps a cerrar

### Task 1: Sincronizar `schema.pg.ts` con `schema.ts` (server)
`schema.pg.ts` le faltan items que sí están en `schema.ts`:
- Tabla `instanceSettings`
- Campo `assemblyaiApiKey` en `userProfiles`
- Campos test en `pipelines`: `testEnabled`, `testCommand`, `testFixEnabled`, `testFixModel`, `testFixMaxIterations`, `testFixerPrompt`

### Task 2: Fix `assignLegacyData()` en `auth.ts` (server)
Usa `db.run(sql`...`)` directo (sync SQLite API). En PG mode crashea.
- Cambiar a `await dbRun(sql`...`)`
- Hacer la función async
- Actualizar callers

### Task 3: Auto-inferir `DB_MODE` desde `AUTH_MODE` (server)
En `db-mode.ts`:
- Si `AUTH_MODE=multi` y `DB_MODE` no está → inferir `postgres`
- Si `AUTH_MODE=local` y `DB_MODE` no está → inferir `sqlite`
- Mantener override explícito

### Task 4: Central ya migrado a PostgreSQL only ✅
Ya hecho en sesión anterior. Solo necesita PG.

### Task 5: Verificar builds
- `bun run build` en server y central

## Configuración final

### Local mode (zero config):
```env
# No se necesita nada.
```

### Multi mode:
```env
# Server (.env)
AUTH_MODE=multi
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Central (.env) — si se usa coordinación de equipos
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

## Lo que NO cambia
- Compat helpers (`dbAll`, `dbGet`, `dbRun`)
- Sistema de migraciones dual-dialect
- Services (ya usan compat helpers)
- Routes (ya son async)
- WebSocket broker
- Agent runner

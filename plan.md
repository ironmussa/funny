# Plan: Agregar 5 temas populares de VS Code a la app

## Enfoque

Usar `next-themes` con custom theme names. Cada tema se define como un CSS class selector (`.theme-dracula`, `.theme-one-dark`, etc.) en `globals.css` que sobrescribe las CSS variables. `next-themes` aplica el class en `<html>` automáticamente.

### Temas a agregar (todos dark)

1. **One Dark Pro** — Inspirado en Atom, tonos azul-grisáceos
2. **Dracula** — Purple accent, alta legibilidad
3. **GitHub Dark** — El look de GitHub.com
4. **Night Owl** — Navy profundo, accent purple (Sarah Drasner)
5. **Catppuccin Mocha** — Pastel warm, muy trendy

Se mantienen **light**, **dark** (el actual) y **system** como base.

## Archivos a modificar

### 1. `packages/client/src/globals.css`

- Agregar 5 bloques CSS con selectores `.theme-one-dark`, `.theme-dracula`, `.theme-github-dark`, `.theme-night-owl`, `.theme-catppuccin`
- Cada bloque define todas las CSS variables: `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--status-*`
- Valores HSL convertidos desde los hex oficiales de cada tema

### 2. `packages/client/src/main.tsx`

- Actualizar `ThemeProvider` con:
  - `themes={['light', 'dark', 'system', 'one-dark', 'dracula', 'github-dark', 'night-owl', 'catppuccin']}`
  - `value={{ 'one-dark': 'theme-one-dark', 'dracula': 'theme-dracula', ... }}` para mapear nombre → CSS class
  - Los temas custom son dark, así que necesitamos `darkTheme` mapping o simplemente dejar `forcedTheme` para que sonner/monaco detecten dark

### 3. `packages/client/src/components/GeneralSettingsDialog.tsx`

- Reemplazar el `SegmentedControl` de 3 opciones por un grid/select de temas
- Mostrar los temas como cards con preview de colores (nombre + mini paleta de 4-5 circles con los colores principales)
- Mantener Light, Dark, System arriba y los 5 custom temas debajo en la sección Appearance

### 4. `packages/client/src/components/ui/sonner.tsx`

- Actualizar para que temas custom resuelvan a `'dark'` para Sonner (ya que todos los custom son dark-based)

### 5. `packages/client/src/components/MonacoEditorDialog.tsx`

- Actualizar para que temas custom resuelvan a `'funny-dark'` en Monaco

### 6. Traducciones (`locales/en/translation.json`, `locales/es/translation.json`, `locales/pt/translation.json`)

- Agregar keys para nombres de temas y actualizar `themeDesc`

## Paletas (hex → HSL conversion)

| Tema             | background | foreground | muted-fg | accent  | border  |
| ---------------- | ---------- | ---------- | -------- | ------- | ------- |
| One Dark Pro     | #282c34    | #abb2bf    | #5c6370  | #528bff | #3e4452 |
| Dracula          | #282A36    | #F8F8F2    | #6272A4  | #BD93F9 | #191A21 |
| GitHub Dark      | #0d1117    | #e6edf3    | #7d8590  | #2f81f7 | #30363d |
| Night Owl        | #011627    | #d6deeb    | #5f7e97  | #7e57c2 | #122d42 |
| Catppuccin Mocha | #1e1e2e    | #cdd6f4    | #a6adc8  | #89b4fa | #45475a |

## Notas de implementación

- `next-themes` con `attribute="class"` pone el class name directamente en `<html>`
- Usamos el prop `value` de ThemeProvider para mapear theme name → CSS class name
- `resolvedTheme` para custom themes devuelve el theme name (ej: `"dracula"`) no `"dark"` — necesitamos manejar esto en sonner.tsx y MonacoEditorDialog.tsx
- Los temas custom no necesitan una versión light, son dark-only
- `enableSystem` sigue funcionando para light/dark

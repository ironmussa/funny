# Plan: Migrar el sidebar al componente Sidebar de shadcn/ui

## Estado actual
- El componente shadcn `Sidebar` ya fue instalado correctamente (`ui/sidebar.tsx`, `ui/sheet.tsx`, `ui/separator.tsx`, `ui/skeleton.tsx`, `hooks/use-mobile.tsx`)
- Las CSS variables (`--sidebar-*`) ya están en `globals.css` (light + dark)
- Los colores de `sidebar` ya están en `tailwind.config.ts`
- El sidebar actual (`Sidebar.tsx`) es un `<div>` plano con contenido, renderizado en `App.tsx` dentro de un `<aside className="w-80">`

## Cambios a realizar

### 1. `App.tsx` — Envolver con `SidebarProvider` y reestructurar layout
- Importar `SidebarProvider`, `SidebarInset`, `SidebarTrigger` desde `@/components/ui/sidebar`
- Envolver el layout en `<SidebarProvider>` (reemplaza el `<div className="flex h-screen">`)
- Reemplazar el `<aside className="w-80">` por el uso del componente shadcn `<Sidebar>` con `collapsible="offcanvas"`
- Mover el contenido principal a `<SidebarInset>` (reemplaza `<main>`)
- Colocar `<SidebarTrigger>` en la parte superior del contenido principal (o en un header bar) para ocultar/mostrar
- Ajustar el `--sidebar-width` a `20rem` (equivalente al `w-80` actual) via la prop `style` del `SidebarProvider`
- Eliminar el `<TooltipProvider>` del root ya que `SidebarProvider` incluye uno propio (o anidarlo si es necesario para otros tooltips)

### 2. `Sidebar.tsx` — Adaptar para usar primitivas de shadcn
- Renombrar la exportación actual `Sidebar` a `AppSidebar` para evitar conflicto de nombres con el componente de shadcn
- Envolver con `<Sidebar>` de shadcn (importado como `SidebarPrimitive` o similar)
- Usar `<SidebarHeader>` para el área top (donde iría el trigger o el logo)
- Usar `<SidebarContent>` en lugar del `<ScrollArea>` actual (ya tiene overflow auto)
- Usar `<SidebarFooter>` para la sección del usuario (auth multi mode)
- Mantener los diálogos tal cual (están fuera del layout del sidebar)

### 3. Ajuste de `min-h-svh` a `h-screen`
- El `SidebarProvider` de shadcn usa `min-h-svh` por defecto. Dado que esta app usa `h-screen overflow-hidden`, sobreescribiremos esa clase con `className="h-screen overflow-hidden"` en el provider.

### 4. Ajuste menor en `tailwind.config.ts`
- Corregir `darkMode: ['class', 'class']` (duplicado por el CLI) a `darkMode: 'class'`

## Archivos que se modifican
1. `packages/client/src/App.tsx`
2. `packages/client/src/components/Sidebar.tsx`
3. `packages/client/tailwind.config.ts` (fix menor)

## Resultado esperado
- Sidebar colapsable con animación suave (offcanvas, sale y entra desde la izquierda)
- Icono `PanelLeft` en la parte superior del main content para toggle
- Atajo de teclado `Ctrl+B` para toggle (viene built-in con shadcn sidebar)
- En mobile (<768px) se muestra como Sheet/drawer con overlay
- Todo el contenido actual del sidebar se mantiene igual

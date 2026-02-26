import { ThemeProvider } from 'next-themes';
import React, { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppShellSkeleton } from './components/AppShellSkeleton';
import { TooltipProvider } from './components/ui/tooltip';
import { useAuthStore } from './stores/auth-store';
import { useSettingsStore } from './stores/settings-store';
import '@fontsource/geist-sans/latin.css';
import '@fontsource/geist-mono/latin.css';
import './globals.css';
import './i18n/config';

// Lazy-load conditional views to reduce initial bundle (~175KB savings)
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));
const MobilePage = lazy(() =>
  import('./components/MobilePage').then((m) => ({ default: m.MobilePage })),
);
const LoginPage = lazy(() =>
  import('./components/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const PreviewBrowser = lazy(() =>
  import('./components/PreviewBrowser').then((m) => ({ default: m.PreviewBrowser })),
);
const SetupWizard = lazy(() =>
  import('./components/SetupWizard').then((m) => ({ default: m.SetupWizard })),
);

// The preview window sets this flag via Tauri's initialization_script
const isPreviewWindow = !!(window as unknown as { __PREVIEW_MODE__: unknown }).__PREVIEW_MODE__;

// Matches Tailwind's `md` breakpoint (768px)
const mobileQuery = window.matchMedia('(max-width: 767px)');
const subscribe = (cb: () => void) => {
  mobileQuery.addEventListener('change', cb);
  return () => mobileQuery.removeEventListener('change', cb);
};
const getSnapshot = () => mobileQuery.matches;

function ResponsiveShell() {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot);
  return <Suspense fallback={<AppShellSkeleton />}>{isMobile ? <MobilePage /> : <App />}</Suspense>;
}

function AuthGate() {
  const mode = useAuthStore((s) => s.mode);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (isLoading) {
    return <AppShellSkeleton />;
  }

  // Multi mode and not authenticated -> show login page
  if (mode === 'multi' && !isAuthenticated) {
    return (
      <Suspense fallback={<AppShellSkeleton />}>
        <LoginPage />
      </Suspense>
    );
  }

  // Setup not completed -> show setup wizard
  if (!setupCompleted) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        }
      >
        <SetupWizard />
      </Suspense>
    );
  }

  // Local mode or authenticated multi -> show app
  return (
    <BrowserRouter>
      <ResponsiveShell />
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      themes={[
        'light',
        'dark',
        'system',
        'one-dark',
        'dracula',
        'github-dark',
        'night-owl',
        'catppuccin',
        'monochrome',
      ]}
      value={{
        light: 'light',
        dark: 'dark',
        'one-dark': 'theme-one-dark',
        dracula: 'theme-dracula',
        'github-dark': 'theme-github-dark',
        'night-owl': 'theme-night-owl',
        catppuccin: 'theme-catppuccin',
        monochrome: 'theme-monochrome',
      }}
    >
      <TooltipProvider delayDuration={300} skipDelayDuration={0}>
        {isPreviewWindow ? (
          <Suspense fallback={null}>
            <PreviewBrowser />
          </Suspense>
        ) : (
          <AuthGate />
        )}
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

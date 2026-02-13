import React, { useEffect, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { MobilePage } from './components/MobilePage';
import { LoginPage } from './components/LoginPage';
import { PreviewBrowser } from './components/PreviewBrowser';
import { useAuthStore } from './stores/auth-store';
import '@fontsource/geist-sans';
import '@fontsource/geist-mono';
import './globals.css';
// Eagerly import so the persisted theme is applied before first paint
import './stores/settings-store';
import './i18n/config';

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
  return isMobile ? <MobilePage /> : <App />;
}

function AuthGate() {
  const mode = useAuthStore((s) => s.mode);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  // Multi mode and not authenticated -> show login page
  if (mode === 'multi' && !isAuthenticated) {
    return <LoginPage />;
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
    {isPreviewWindow ? (
      <PreviewBrowser />
    ) : (
      <AuthGate />
    )}
  </React.StrictMode>
);

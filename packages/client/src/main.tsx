import './wdyr'; // must be first — tracks unnecessary re-renders in dev
import { AbbacchioProvider } from '@abbacchio/browser-transport/react';

// Swallow benign "ResizeObserver loop completed with undelivered notifications"
// errors before any other listener (Abbacchio, React) sees them. They surface
// during Radix Collapsible/Sidebar layout transitions and have no user impact.
// Must run before AbbacchioProvider attaches its window error listener.
const RESIZE_OBSERVER_LOOP_RE =
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
window.addEventListener(
  'error',
  (e) => {
    if (e.message && RESIZE_OBSERVER_LOOP_RE.test(e.message)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true,
);
import { ThemeProvider, useTheme } from 'next-themes';
import React, { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppShellSkeleton } from './components/AppShellSkeleton';
import { TooltipProvider } from './components/ui/tooltip';
import { api } from './lib/api';
import { initWebVitals } from './lib/web-vitals';
import { useAuthStore } from './stores/auth-store';
import { useProfileStore } from './stores/profile-store';
import { useSettingsStore } from './stores/settings-store';
import '@fontsource/geist-sans/latin.css';
import '@fontsource/geist-mono/latin.css';
import '@fontsource/noto-sans/latin.css';
import '@fontsource/noto-sans-mono/latin.css';
import '@fontsource/jetbrains-mono/latin.css';
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
const AcceptInvitePage = lazy(() =>
  import('./components/AcceptInvitePage').then((m) => ({ default: m.AcceptInvitePage })),
);
const PreviewBrowser = lazy(() =>
  import('./components/PreviewBrowser').then((m) => ({ default: m.PreviewBrowser })),
);
const SetupWizard = lazy(() =>
  import('./components/SetupWizard').then((m) => ({ default: m.SetupWizard })),
);

// Start Web Vitals capture as early as possible so we measure the real LCP/FCP.
initWebVitals();

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

/** Extract invite token from URL path like /invite/<token> */
function getInviteToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
  return match ? match[1] : null;
}

function AuthGate() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);
  const initializeFromProfile = useSettingsStore((s) => s.initializeFromProfile);
  const { setTheme } = useTheme();
  const [inviteToken] = useState<string | null>(getInviteToken);
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(() => {
    // Use cached value so a backend restart doesn't flash the setup wizard
    return localStorage.getItem('funny:setupCompleted') === 'true' ? true : null;
  });

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Fetch profile from server once authenticated (or in local mode)
  // This loads setup status, settings, and theme in a single request.
  // Retries on failure so a slow server start doesn't force the user
  // back through the setup wizard.
  const canCheckSetup = !isLoading && isAuthenticated;
  useEffect(() => {
    if (!canCheckSetup) return;

    let retries = 0;
    const maxRetries = 3;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const fetchProfile = () => {
      api.getProfile().then((res) => {
        if (cancelled) return;
        if (res.isOk()) {
          const profile = res.value;
          useProfileStore.getState().setProfile(profile);
          const completed = profile.setupCompleted ?? false;
          setSetupCompleted(completed);
          if (completed) {
            localStorage.setItem('funny:setupCompleted', 'true');
          } else {
            localStorage.removeItem('funny:setupCompleted');
          }
          initializeFromProfile(profile);
          if (profile.theme) {
            setTheme(profile.theme);
          }
        } else if (retries < maxRetries) {
          // Server might still be starting — retry with backoff
          retries++;
          retryTimeout = setTimeout(fetchProfile, retries * 1000);
        } else {
          // Profile 401 does not auto-logout (see api.ts). Re-check Better Auth session; if the
          // cookie never stuck, this clears isAuthenticated and returns to login with a real cause.
          void useAuthStore
            .getState()
            .initialize()
            .then(() => {
              if (cancelled) return;
              if (!useAuthStore.getState().isAuthenticated) return;
              if (!setupCompleted) {
                setSetupCompleted(false);
              }
            });
        }
      });
    };

    fetchProfile();

    return () => {
      cancelled = true;
      if (retryTimeout !== undefined) clearTimeout(retryTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCheckSetup, initializeFromProfile, setTheme]);

  if (isLoading) {
    return <AppShellSkeleton />;
  }

  // Invite link: show the accept/register page regardless of auth state.
  // The AcceptInvitePage handles both registration and login internally.
  if (inviteToken) {
    return (
      <Suspense fallback={<AppShellSkeleton />}>
        <AcceptInvitePage token={inviteToken} />
      </Suspense>
    );
  }

  // Not authenticated -> show login page
  if (!isAuthenticated) {
    return (
      <Suspense fallback={<AppShellSkeleton />}>
        <LoginPage />
      </Suspense>
    );
  }

  // Wait for setup status to load
  if (setupCompleted === null) {
    return <AppShellSkeleton />;
  }

  // Setup not completed -> show setup wizard
  if (!setupCompleted) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="text-sm text-muted-foreground">Loading…</div>
          </div>
        }
      >
        <SetupWizard onComplete={() => setSetupCompleted(true)} />
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

// Reuse the existing root on HMR to prevent "createRoot on a container that
// has already been passed to createRoot" errors.
// Store the root on import.meta.hot.data so Vite HMR preserves it across module re-executions.
const rootEl = document.getElementById('root')!;
const root: ReactDOM.Root =
  (import.meta.hot?.data?.reactRoot as ReactDOM.Root | undefined) ?? ReactDOM.createRoot(rootEl);
if (import.meta.hot) {
  import.meta.hot.data.reactRoot = root;
}

root.render(
  <React.StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="one-dark"
      disableTransitionOnChange
      themes={[
        'one-dark',
        'dracula',
        'github-dark',
        'night-owl',
        'catppuccin',
        'sunrise',
        'monochrome',
        'monochrome-dark',
      ]}
      value={{
        'one-dark': 'theme-one-dark',
        dracula: 'theme-dracula',
        'github-dark': 'theme-github-dark',
        'night-owl': 'theme-night-owl',
        catppuccin: 'theme-catppuccin',
        sunrise: 'theme-sunrise',
        monochrome: 'theme-monochrome',
        'monochrome-dark': 'theme-monochrome-dark',
      }}
    >
      <AbbacchioProvider
        endpoint={import.meta.env.VITE_OTLP_ENDPOINT || 'http://localhost:4000'}
        serviceName="funny-client"
        captureConsole
        level="debug"
        enabled={!!import.meta.env.VITE_OTLP_ENDPOINT}
        includeUrl={true}
        consoleOptions={{
          captureErrors: true,
          captureUnhandledRejections: true,
          captureLongTasks: true,
          captureSlowEvents: true,
          slowEventThresholdMs: 50,
          captureStackTrace: true,
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
      </AbbacchioProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

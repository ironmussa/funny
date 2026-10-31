import { AlertTriangle } from 'lucide-react';
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Label shown in the fallback UI to identify which area crashed */
  area?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render errors in child components and shows a retry fallback
 * instead of crashing the entire app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.area ? `:${this.props.area}` : ''}]`, error, info);
  }

  render() {
    if (this.state.hasError) {
      // React.lazy caches a rejected import. Resetting this boundary alone
      // would immediately throw the same error, so offer an explicit reload.
      const moduleLoadFailed =
        this.state.error !== null &&
        /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|Unable to preload CSS/i.test(
          this.state.error.message,
        );
      return (
        <div
          className="flex size-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
          data-testid={`error-boundary-${this.props.area ?? 'unknown'}`}
        >
          <AlertTriangle className="text-status-warning size-8" />
          <p className="text-muted-foreground text-sm">
            {moduleLoadFailed
              ? 'Part of the app could not be downloaded. Check your connection, then reload the page.'
              : `Something went wrong${this.props.area ? ` in ${this.props.area}` : ''}.`}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid={`error-boundary-retry-${this.props.area ?? 'unknown'}`}
            onClick={() => {
              if (moduleLoadFailed) {
                window.location.reload();
              } else {
                this.setState({ hasError: false, error: null });
              }
            }}
          >
            {moduleLoadFailed ? 'Reload page' : 'Try again'}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

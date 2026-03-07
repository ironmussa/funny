import whyDidYouRender from '@welldone-software/why-did-you-render';
/// <reference types="@welldone-software/why-did-you-render" />
import * as React from 'react';

if (import.meta.env.DEV) {
  // Lazy-load telemetry to avoid circular deps at module init
  const telemetry = import('./lib/telemetry');
  const loggerMod = import('./lib/client-logger');

  // Throttle: max 1 report per component every 2 seconds
  const lastReport = new Map<string, number>();
  const THROTTLE_MS = 2_000;

  whyDidYouRender(React, {
    trackAllPureComponents: true,
    collapseGroups: true,
    notifier({ Component, displayName, reason }) {
      const component = displayName || (Component as any)?.displayName || 'Unknown';
      const now = Date.now();
      const last = lastReport.get(component) ?? 0;
      if (now - last < THROTTLE_MS) return;
      lastReport.set(component, now);

      // Metric — count by component
      telemetry.then(({ metric }) => {
        metric('client.rerender.unnecessary', 1, {
          type: 'sum',
          attributes: { component },
        });
      });

      // Log with detail
      loggerMod.then(({ createClientLogger }) => {
        const logger = createClientLogger('wdyr');
        logger.warn(`unnecessary-rerender: ${component}`, {
          component,
          'reason.propsDifferences': JSON.stringify(reason?.propsDifferences ?? []),
          'reason.stateDifferences': JSON.stringify(reason?.stateDifferences ?? []),
        });
      });
    },
  });
}

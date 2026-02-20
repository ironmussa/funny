import { type MiddlewareHandler } from 'hono';
import { SpanStatusCode, context, propagation } from '@opentelemetry/api';
import { getTracer } from './tracer.js';
import { getMeter, createHttpInstruments, type HttpInstruments } from './metrics.js';

let instruments: HttpInstruments | null = null;

function getInstruments(): HttpInstruments {
  if (!instruments) {
    instruments = createHttpInstruments(getMeter());
  }
  return instruments;
}

export function observabilityMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const tracer = getTracer();
    const inst = getInstruments();
    const url = new URL(c.req.url);
    const method = c.req.method;
    const route = c.req.routePath ?? url.pathname;

    // Extract trace context from incoming headers (W3C traceparent)
    const parentContext = propagation.extract(context.active(), c.req.raw.headers, {
      get(carrier, key) {
        return (carrier as Headers).get(key) ?? undefined;
      },
      keys(carrier) {
        return [...(carrier as Headers).keys()];
      },
    });

    const attributes = {
      'http.method': method,
      'http.url': url.pathname,
      'http.route': route,
      'http.target': url.pathname + url.search,
    };

    inst.activeRequests.add(1, { 'http.method': method });
    const start = performance.now();

    await context.with(parentContext, async () => {
      await tracer.startActiveSpan(`${method} ${route}`, { attributes }, async (span) => {
        try {
          await next();

          const status = c.res.status;
          span.setAttribute('http.status_code', status);

          if (status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
          }

          const duration = performance.now() - start;
          const metricAttrs = {
            'http.method': method,
            'http.route': route,
            'http.status_code': status,
          };

          inst.requestDuration.record(duration, metricAttrs);
          inst.requestTotal.add(1, metricAttrs);
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          span.recordException(err as Error);
          throw err;
        } finally {
          inst.activeRequests.add(-1, { 'http.method': method });
          span.end();
        }
      });
    });
  };
}

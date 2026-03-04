import { trace } from '@opentelemetry/api';
import type { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { Resource } from '@opentelemetry/resources';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';

let provider: NodeTracerProvider | null = null;

export function initTracer(resource: Resource, exporter: OTLPTraceExporter): void {
  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
}

export function getTracer(name = 'funny-server') {
  return trace.getTracer(name);
}

export async function shutdownTracer(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}

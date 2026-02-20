import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { Resource } from '@opentelemetry/resources';
import type { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

let provider: NodeTracerProvider | null = null;

export function initTracer(resource: Resource, exporter: OTLPTraceExporter): void {
  provider = new NodeTracerProvider({ resource });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
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

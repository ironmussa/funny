import {
  benchmarkStateChecksum,
  type RendererBenchmarkFixture,
  type RendererBenchmarkFixturePair,
  type RendererBenchmarkState,
} from '@funny/client-benchmark';

const DIFF_PATCH = [
  'diff --git a/renderer.ts b/renderer.ts',
  'index 1111111..2222222 100644',
  '--- a/renderer.ts',
  '+++ b/renderer.ts',
  '@@ -1 +1 @@',
  '-const renderer = "dom";',
  '+const renderer = "gpuix";',
].join('\n');

export interface GpuixMessageRow {
  id: string;
  role: 'user' | 'assistant';
  markdown: string;
  toolCalls: { id: string; name: string; code: string }[];
  diffPatch: string | null;
}

export function buildGpuixRows(
  fixture: RendererBenchmarkFixture,
  streamRevision: number,
): GpuixMessageRow[] {
  return fixture.messages.map((message, index) => ({
    id: message.id,
    role: message.role,
    markdown:
      streamRevision > 0 && index === fixture.messages.length - 1
        ? `${message.content}\n\nstream revision ${streamRevision}`
        : message.content,
    toolCalls: message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      code: toolCall.output ?? toolCall.input,
    })),
    diffPatch: message.content.includes('```diff\n') ? DIFF_PATCH : null,
  }));
}

export function gpuixFinalStateChecksum(
  fixtures: RendererBenchmarkFixturePair,
  state: RendererBenchmarkState,
): string {
  return benchmarkStateChecksum(fixtures, state);
}

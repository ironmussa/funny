/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * Embedding provider abstraction. Supports Ollama (local) and OpenAI.
 * Falls back to a null provider (no-op) when neither is available.
 */

import { log } from './logger.js';
import type { EmbeddingProvider } from './types.js';

// ─── Ollama provider ────────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly model: string = 'nomic-embed-text',
    private readonly baseUrl: string = 'http://localhost:11434',
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    return new Float32Array(data.embeddings[0]);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Ollama supports batch in a single call
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embedBatch failed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => new Float32Array(e));
  }

  dimensions(): number {
    // nomic-embed-text produces 768-dimensional vectors
    return 768;
  }

  modelId(): string {
    return `ollama:${this.model}`;
  }
}

// ─── OpenAI provider ────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'text-embedding-3-small',
    private readonly baseUrl: string = 'https://api.openai.com/v1',
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI embed failed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI embedBatch failed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    // OpenAI returns sorted by index
    return data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d) => new Float32Array(d.embedding));
  }

  dimensions(): number {
    // text-embedding-3-small defaults to 1536
    return 1536;
  }

  modelId(): string {
    return `openai:${this.model}`;
  }
}

// ─── Null provider (no-op fallback) ─────────────────────

export class NullEmbeddingProvider implements EmbeddingProvider {
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(0);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }

  dimensions(): number {
    return 0;
  }

  modelId(): string {
    return 'null';
  }
}

// ─── Provider factory ───────────────────────────────────

export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  const provider = process.env.MEMORY_EMBEDDING_PROVIDER;

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log.warn('MEMORY_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY not set, using null provider', {
        namespace: 'memory',
      });
      return new NullEmbeddingProvider();
    }
    log.info('Using OpenAI embedding provider', { namespace: 'memory' });
    return new OpenAIEmbeddingProvider(apiKey);
  }

  if (provider === 'ollama' || !provider) {
    // Try Ollama by default
    const url = process.env.MEMORY_OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.MEMORY_OLLAMA_MODEL || 'nomic-embed-text';

    try {
      const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        log.info(`Using Ollama embedding provider (${model})`, { namespace: 'memory' });
        return new OllamaEmbeddingProvider(model, url);
      }
    } catch {
      // Ollama not running
    }

    if (provider === 'ollama') {
      log.warn('MEMORY_EMBEDDING_PROVIDER=ollama but Ollama not reachable, using null provider', {
        namespace: 'memory',
      });
    } else {
      log.info('No embedding provider available — memory search will use keyword matching only', {
        namespace: 'memory',
      });
    }
    return new NullEmbeddingProvider();
  }

  log.warn(`Unknown MEMORY_EMBEDDING_PROVIDER="${provider}", using null provider`, {
    namespace: 'memory',
  });
  return new NullEmbeddingProvider();
}

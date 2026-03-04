import type { OpenObserveConfig } from './config.js';

export interface SearchResponse {
  took: number;
  hits: Record<string, unknown>[];
  total: number;
  from: number;
  size: number;
  scan_size: number;
}

export interface StreamInfo {
  name: string;
  storage_type: string;
  stream_type: string;
  stats: {
    doc_time_min: number;
    doc_time_max: number;
    doc_num: number;
    file_num: number;
    storage_size: number;
    compressed_size: number;
  };
  schema?: Array<{ name: string; type: string }>;
  settings?: {
    partition_keys: Record<string, unknown>;
    full_text_search_keys: string[];
  };
}

export interface ListStreamsResponse {
  list: StreamInfo[];
}

export interface StreamSchemaResponse {
  name: string;
  storage_type: string;
  stream_type: string;
  stats: {
    doc_time_min: number;
    doc_time_max: number;
    doc_num: number;
    file_num: number;
    storage_size: number;
    compressed_size: number;
  };
  schema: Array<{ name: string; type: string }>;
  settings: {
    partition_keys: Record<string, unknown>;
    full_text_search_keys: string[];
  };
}

export class OpenObserveClient {
  private config: OpenObserveConfig;

  constructor(config: OpenObserveConfig) {
    this.config = config;
  }

  private get apiBase(): string {
    return `${this.config.baseUrl}/api/${this.config.org}`;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: this.config.authHeader,
    };
  }

  async search(params: {
    sql: string;
    startTime: number;
    endTime: number;
    from?: number;
    size?: number;
  }): Promise<SearchResponse> {
    const body = {
      query: {
        sql: params.sql,
        start_time: params.startTime,
        end_time: params.endTime,
        from: params.from ?? 0,
        size: params.size ?? 100,
      },
    };
    const res = await fetch(`${this.apiBase}/_search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenObserve search failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<SearchResponse>;
  }

  async listStreams(
    type: string = 'logs',
    fetchSchema: boolean = false,
  ): Promise<ListStreamsResponse> {
    const url = `${this.apiBase}/streams?type=${type}&fetchSchema=${fetchSchema}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenObserve listStreams failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<ListStreamsResponse>;
  }

  async getSchema(stream: string, type: string = 'logs'): Promise<StreamSchemaResponse> {
    const url = `${this.apiBase}/streams/${encodeURIComponent(stream)}/schema?type=${type}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenObserve getSchema failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<StreamSchemaResponse>;
  }
}

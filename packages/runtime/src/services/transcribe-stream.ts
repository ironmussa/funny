/**
 * Real-time speech-to-text proxy via AssemblyAI Streaming v3 WebSocket API.
 *
 * Following: https://www.assemblyai.com/docs/getting-started/transcribe-streaming-audio
 *
 * Flow:
 * 1. Look up user's AssemblyAI API key
 * 2. Generate a temporary token via HTTP (Bun's WebSocket doesn't support custom headers)
 * 3. Open WebSocket to AssemblyAI with token as query param
 * 4. Proxy raw PCM16 audio from client → AssemblyAI
 * 5. Proxy Turn transcripts from AssemblyAI → client
 */

import { type Result, ok, err } from 'neverthrow';
import WebSocket from 'ws';

import { log } from '../lib/logger.js';
import { getAssemblyaiApiKey } from './profile-service.js';

const API_ENDPOINT_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';

const CONNECTION_PARAMS = {
  speech_model: 'u3-rt-pro',
  sample_rate: '16000',
  encoding: 'pcm_s16le',
};

/**
 * Generate a temporary streaming token via HTTP.
 */
async function createTemporaryToken(apiKey: string): Promise<string> {
  const res = await fetch(`${TOKEN_URL}?expires_in_seconds=600`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.token;
}

/**
 * Create a temporary AssemblyAI token for direct browser→AssemblyAI connections.
 * The API key never leaves the server — only the short-lived token is returned.
 */
export async function createTranscribeToken(userId: string): Promise<Result<string, string>> {
  const apiKey = await getAssemblyaiApiKey(userId);
  if (!apiKey) {
    return err('AssemblyAI API key not configured');
  }
  try {
    const token = await createTemporaryToken(apiKey);
    return ok(token);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('Failed to create transcribe token', { namespace: 'transcribe', error: message });
    return err(message);
  }
}

/**
 * Called when a /ws/transcribe WebSocket opens.
 * Sets up the upstream AssemblyAI real-time connection.
 */
export async function handleTranscribeWs(clientWs: any, userId: string) {
  const apiKey = await getAssemblyaiApiKey(userId);
  if (!apiKey) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'AssemblyAI API key not configured' }));
    clientWs.close(4000, 'No API key');
    return;
  }

  try {
    const token = await createTemporaryToken(apiKey);

    // Build the WebSocket URL with token + params as query string
    const params = new URLSearchParams({ ...CONNECTION_PARAMS, token });
    const wsUrl = `${API_ENDPOINT_BASE}?${params.toString()}`;

    log.info('Connecting to AssemblyAI', { namespace: 'transcribe' });

    // Use `ws` package — supports headers and works correctly in Bun
    const assemblyWs = new WebSocket(wsUrl);
    assemblyWs.binaryType = 'arraybuffer';

    // Store reference so index.ts can forward audio and close it
    clientWs.data.assemblyWs = assemblyWs;

    assemblyWs.on('open', () => {
      log.info('AssemblyAI WebSocket open', { namespace: 'transcribe' });
    });

    assemblyWs.on('message', (message: WebSocket.Data) => {
      try {
        // Bun's ws delivers Buffer where .toString() gives byte values;
        // use Buffer.from() to properly decode UTF-8
        const raw = Buffer.from(message as any).toString('utf-8');
        const data = JSON.parse(raw);

        if (data.type === 'Begin') {
          log.info('AssemblyAI session began', { namespace: 'transcribe', id: data.id });
          clientWs.send(JSON.stringify({ type: 'ready' }));
        } else if (data.type === 'Turn') {
          const transcript = data.transcript || '';
          const isFinal = data.end_of_turn === true;
          log.debug('AssemblyAI Turn', {
            namespace: 'transcribe',
            isFinal: String(isFinal),
            textLength: String(transcript.length),
            text: transcript.slice(0, 80),
          });
          if (transcript) {
            clientWs.send(
              JSON.stringify({
                type: isFinal ? 'final' : 'partial',
                text: transcript,
              }),
            );
          }
        } else if (data.type === 'Termination') {
          log.info('AssemblyAI session terminated', {
            namespace: 'transcribe',
            audioDuration: data.audio_duration_seconds,
          });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    assemblyWs.on('error', (err: Error) => {
      log.error('AssemblyAI WS error', { namespace: 'transcribe', error: err.message });
      try {
        clientWs.send(JSON.stringify({ type: 'error', message: 'AssemblyAI connection error' }));
      } catch {}
    });

    assemblyWs.on('close', (code: number, reason: Buffer) => {
      log.info('AssemblyAI WS closed', {
        namespace: 'transcribe',
        code,
        reason: reason.toString(),
      });
      try {
        clientWs.send(JSON.stringify({ type: 'closed' }));
      } catch {}
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to connect to AssemblyAI', { namespace: 'transcribe', error: message });
    try {
      clientWs.send(JSON.stringify({ type: 'error', message }));
    } catch {}
  }
}

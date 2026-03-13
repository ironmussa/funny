/**
 * Real-time dictation hook using AssemblyAI streaming v3.
 *
 * Connects directly from the browser to AssemblyAI — no server proxy.
 * The server only provides a short-lived token (API key never leaves server).
 *
 * Captures microphone audio at 16kHz PCM16 and streams it via WebSocket.
 */

import { Result } from 'neverthrow';
import { useCallback, useRef, useState } from 'react';

import { api } from '@/lib/api';

const ASSEMBLYAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';

/** Play a short synthesized beep. Rising tone = mic on, falling tone = mic off. */
function playBeep(type: 'on' | 'off'): Result<void, string> {
  return Result.fromThrowable(
    () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);

      if (type === 'on') {
        // Rising two-tone: 440 → 660 Hz
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.08);
      } else {
        // Falling two-tone: 660 → 440 Hz
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.setValueAtTime(440, ctx.currentTime + 0.08);
      }

      gain.gain.setValueAtTime(0.15, ctx.currentTime + 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
      osc.onended = () => ctx.close().catch(() => {});
    },
    (e) => `Audio playback failed: ${e}`,
  )();
}

interface UseDictationOptions {
  /** Called with partial (in-progress) transcript text */
  onPartial?: (text: string) => void;
  /** Called with final (committed) transcript text */
  onFinal?: (text: string) => void;
  /** Called on error */
  onError?: (message: string) => void;
}

export function useDictation({ onPartial, onFinal, onError }: UseDictationOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Keep refs in sync so callbacks don't capture stale closure values
  const isRecordingRef = useRef(false);
  const isConnectingRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const cleanup = useCallback(() => {
    // Stop mic stream
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // Disconnect audio nodes
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;

    // Close audio context
    if (audioContextRef.current?.state !== 'closed') {
      audioContextRef.current?.close().catch(() => {});
    }
    audioContextRef.current = null;

    // Close WebSocket — send Terminate first if open
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'Terminate' }));
      } catch {}
      wsRef.current.close();
    }
    wsRef.current = null;

    isRecordingRef.current = false;
    isConnectingRef.current = false;
    setIsRecording(false);
    setIsConnecting(false);
  }, []);

  const start = useCallback(async () => {
    if (isRecordingRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;
    setIsConnecting(true);

    try {
      // 1. Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // 2. Get temporary token from our server (API key stays server-side)
      const tokenResult = await api.getTranscribeToken();
      if (tokenResult.isErr()) {
        throw new Error(tokenResult.error.message || 'Failed to get transcription token');
      }
      const { token } = tokenResult.value;

      // 3. Connect directly to AssemblyAI
      // Using universal-streaming-multilingual: emits immutable words individually
      // (~300ms latency per word) — ideal for dictation. Supports EN, ES, FR, DE, IT, PT.
      // u3-rt-pro only emits during silence pauses which is unsuitable for dictation.
      const params = new URLSearchParams({
        speech_model: 'universal-streaming-multilingual',
        sample_rate: '16000',
        encoding: 'pcm_s16le',
        token,
      });
      const ws = new WebSocket(`${ASSEMBLYAI_WS_BASE}?${params.toString()}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Wait for AssemblyAI's Begin message
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'Begin') {
              clearTimeout(timeout);
              resolve();
            } else if (data.type === 'Error') {
              clearTimeout(timeout);
              reject(new Error(data.error || 'AssemblyAI connection error'));
            }
          } catch {}
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onclose = () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket closed before ready'));
        };
      });

      // 4. Set up message handler for transcripts
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Turn') {
            const transcript = data.transcript || '';
            if (!transcript) return;
            if (data.end_of_turn) {
              onFinal?.(transcript);
            } else {
              onPartial?.(transcript);
            }
          } else if (data.type === 'Termination') {
            cleanup();
          }
        } catch {}
      };

      ws.onclose = () => cleanup();
      ws.onerror = () => {
        onError?.('Connection lost');
        cleanup();
      };

      // 5. Set up AudioContext to capture PCM16 at 16kHz
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Smaller buffer = more frequent audio chunks = faster silence detection
      const bufferSize = 2048;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert float32 [-1,1] to int16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        ws.send(pcm16.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      isConnectingRef.current = false;
      isRecordingRef.current = true;
      setIsConnecting(false);
      setIsRecording(true);
      playBeep('on');
    } catch (err: any) {
      onError?.(err?.message || 'Failed to start dictation');
      cleanup();
    }
  }, [onPartial, onFinal, onError, cleanup]);

  const stop = useCallback(() => {
    if (!isRecordingRef.current) return;
    playBeep('off');
    cleanup();
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
    } else {
      start();
    }
  }, [isRecording, start, stop]);

  return {
    isRecording,
    isConnecting,
    start,
    stop,
    toggle,
  };
}

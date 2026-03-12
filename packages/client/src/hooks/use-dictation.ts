/**
 * Real-time dictation hook using AssemblyAI streaming via WebSocket.
 *
 * Captures microphone audio at 16kHz PCM16, streams it to the server
 * which proxies to AssemblyAI, and returns partial/final transcripts.
 */

import { useCallback, useRef, useState } from 'react';

import { getAuthToken, getAuthMode } from '@/lib/api';

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

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Fallback for browsers without AudioWorklet
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const cleanup = useCallback(() => {
    // Stop mic stream
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // Disconnect audio nodes
    workletRef.current?.disconnect();
    workletRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;

    // Close audio context
    if (audioContextRef.current?.state !== 'closed') {
      audioContextRef.current?.close().catch(() => {});
    }
    audioContextRef.current = null;

    // Close WebSocket (server handles sending Terminate to AssemblyAI)
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;

    setIsRecording(false);
    setIsConnecting(false);
  }, []);

  const start = useCallback(async () => {
    if (isRecording || isConnecting) return;
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

      // 2. Open WebSocket to server
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const authMode = getAuthMode();
      const tokenParam = authMode !== 'multi' && getAuthToken() ? `?token=${getAuthToken()}` : '';
      const ws = new WebSocket(`${protocol}//${host}/ws/transcribe${tokenParam}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'ready') {
              clearTimeout(timeout);
              resolve();
            } else if (data.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(data.message));
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

      // 3. Set up message handler for transcripts
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'partial' && data.text) {
            onPartial?.(data.text);
          } else if (data.type === 'final' && data.text) {
            onFinal?.(data.text);
          } else if (data.type === 'error') {
            onError?.(data.message);
          } else if (data.type === 'closed') {
            cleanup();
          }
        } catch {}
      };

      ws.onclose = () => {
        cleanup();
      };

      ws.onerror = () => {
        onError?.('Connection lost');
        cleanup();
      };

      // 4. Set up AudioContext to capture PCM16 at 16kHz
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Use ScriptProcessorNode (widely supported) to capture raw PCM
      const bufferSize = 4096;
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

        // Send raw PCM16 binary to server → AssemblyAI (v3 expects raw bytes)
        ws.send(new Uint8Array(pcm16.buffer));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setIsConnecting(false);
      setIsRecording(true);
    } catch (err: any) {
      onError?.(err?.message || 'Failed to start dictation');
      cleanup();
    }
  }, [isRecording, isConnecting, onPartial, onFinal, onError, cleanup]);

  const stop = useCallback(() => {
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

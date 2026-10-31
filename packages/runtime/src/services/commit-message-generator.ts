import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveSDKCliPath } from '@funny/core/agents';
import { runAsync } from '@funny/shared/async';

import { log } from '../lib/logger.js';
import { COMMIT_MESSAGE_SYSTEM_PROMPT } from './pipeline-prompts.js';

/** Own the SDK query for the request lifetime, including its underlying process. */
export async function generateCommitMessage(options: {
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ text: string } | { error: string }> {
  try {
    const text = await runAsync(
      async (signal) => {
        const controller = new AbortController();
        let gen: ReturnType<typeof query> | undefined;
        const close = () => {
          const owned = gen;
          gen = undefined;
          owned?.close();
        };
        const abort = () => {
          controller.abort(signal.reason);
          close();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        try {
          gen = query({
            prompt: options.prompt,
            options: {
              cwd: options.cwd,
              maxTurns: 1,
              permissionMode: 'plan',
              abortController: controller,
              pathToClaudeCodeExecutable: resolveSDKCliPath(),
              systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
              tools: [],
            },
          });
          let resultText = '';
          for await (const msg of gen) {
            if (msg.type === 'assistant') {
              const text = msg.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
              if (text) resultText = text;
            }
            if (msg.type === 'result') {
              return ('result' in msg && msg.result) || resultText;
            }
          }
          return resultText;
        } finally {
          signal.removeEventListener('abort', abort);
          close();
        }
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 60_000,
        timeoutError: () => new Error('Commit message generation timed out'),
      },
    );
    return text ? { text } : { error: 'No output received' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error('SDK query error generating commit message', { namespace: 'git', error: message });
    return { error: message };
  }
}

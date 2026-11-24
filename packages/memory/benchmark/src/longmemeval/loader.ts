import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type {
  LongMemEvalDataset,
  LongMemSession,
  LongMemTurn,
  LongMemQuestion,
  ComplexityLevel,
} from './types.js';

/**
 * LongMemEval dataset: Multi-session conversations at different scales
 * with questions at 5 complexity levels.
 *
 * Source: https://huggingface.co/datasets/xiaowu0162/LongMemEval
 * Paper: https://arxiv.org/abs/2407.15045
 */
const LONGMEMEVAL_URLS: Record<string, string> = {
  S: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_s.json',
  M: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_m.json',
  L: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_l.json',
};

export async function loadLongMemEvalDataset(
  dataDir: string,
  size: 'S' | 'M' | 'L' = 'S',
): Promise<LongMemEvalDataset> {
  const cacheFile = `longmemeval_${size.toLowerCase()}.json`;
  const cachePath = join(dataDir, cacheFile);

  if (!existsSync(cachePath)) {
    console.log(`Downloading LongMemEval-${size} dataset...`);
    await mkdir(dataDir, { recursive: true });

    const url = LONGMEMEVAL_URLS[size];
    const res = await fetch(url);

    if (!res.ok) {
      // Try alternative URL patterns common for HuggingFace datasets
      console.log(`Primary URL failed (${res.status}), trying alternative...`);
      const altRes = await fetch(
        `https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_${size.toLowerCase()}.json`,
      );
      if (!altRes.ok) {
        throw new Error(
          `Failed to download LongMemEval-${size}: ${res.status}. ` +
            `You can manually place the dataset file at ${cachePath}`,
        );
      }
      const text = await altRes.text();
      await writeFile(cachePath, text);
    } else {
      const text = await res.text();
      await writeFile(cachePath, text);
    }

    console.log(`Cached LongMemEval-${size} at ${cachePath}`);
  }

  const raw = await readFile(cachePath, 'utf-8');
  const data = JSON.parse(raw);

  return parseLongMemEvalData(data, size);
}

function parseLongMemEvalData(data: unknown, size: 'S' | 'M' | 'L'): LongMemEvalDataset {
  // SAFETY: a LongMemEval file is a JSON object of sessions and questions; a malformed file fails
  // below while reading it, as it always has.
  const root = data as Record<string, unknown>;

  // Parse sessions
  // SAFETY: LongMemEval keeps its sessions in an array (sessions / conversations / dialogs); a
  // non-array fails at map(), as it always has.
  const rawSessions = (root.sessions ?? root.conversations ?? root.dialogs ?? []) as unknown[];
  const sessions: LongMemSession[] = rawSessions.map((s, i) => {
    // SAFETY: a LongMemEval session is an object (id, turns, timestamp); the loader passes dataset fields through unvalidated, as it always has.
    const raw = s as Record<string, unknown>;
    // SAFETY: a session's turns are an array (turns / messages / dialog); a non-array fails at map().
    const rawTurns = (raw.turns ?? raw.messages ?? raw.dialog ?? []) as unknown[];
    const turns: LongMemTurn[] = rawTurns.map((t) => {
      // SAFETY: a LongMemEval turn is an object with string speaker/role and text/content fields;
      // the loader passes dataset fields through unvalidated, as it always has.
      const turn = t as Record<string, unknown>;
      // SAFETY: as above, speaker/role and text/content are LongMemEval's string turn fields.
      return {
        speaker: (turn.speaker ?? turn.role ?? 'user') as string,
        text: (turn.text ?? turn.content ?? '') as string,
      };
    });

    // SAFETY: a session's id and timestamp are strings; the loader passes dataset fields through unvalidated, as it always has.
    return {
      session_id: (raw.session_id ?? raw.id ?? `session-${i}`) as string,
      turns,
      timestamp: raw.timestamp as string | undefined,
    };
  });

  // Parse questions
  // SAFETY: LongMemEval keeps its questions in an array (questions / queries / qa_pairs); a
  // non-array fails at map(), as it always has.
  const rawQs = (root.questions ?? root.queries ?? root.qa_pairs ?? []) as unknown[];
  const questions: LongMemQuestion[] = rawQs.map((q, i) => {
    // SAFETY: a LongMemEval question is an object; the loader passes dataset fields through unvalidated, as it always has.
    const raw = q as Record<string, unknown>;
    // SAFETY: a question's level / complexity is a number from 1 to 5, clamped below.
    const level = (raw.level ?? raw.complexity ?? 1) as number;

    // SAFETY: a question's id, question and answer are strings, requires_abstention a boolean and
    // relevant_sessions an array of session ids; the level is clamped to 1..5 (a ComplexityLevel
    // for the integer levels the dataset uses). The loader passes dataset fields through unvalidated, as it always has.
    return {
      question_id: (raw.question_id ?? raw.id ?? `lme-q${i}`) as string,
      question: (raw.question ?? raw.query ?? '') as string,
      answer: (raw.answer ?? raw.ground_truth ?? '') as string,
      level: Math.max(1, Math.min(5, level)) as ComplexityLevel,
      requires_abstention: level === 5 || (raw.requires_abstention as boolean | undefined),
      relevant_sessions: raw.relevant_sessions as string[] | undefined,
    };
  });

  // Estimate total tokens (rough: 1 token ≈ 4 chars)
  const totalChars = sessions.reduce(
    (sum, s) => sum + s.turns.reduce((ts, t) => ts + t.text.length, 0),
    0,
  );

  return {
    size,
    sessions,
    questions,
    totalTokens: Math.ceil(totalChars / 4),
  };
}

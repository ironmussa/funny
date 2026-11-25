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
const LONGMEMEVAL_URLS = {
  S: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_s.json',
  M: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_m.json',
  L: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_l.json',
} satisfies Record<'S' | 'M' | 'L', string>;

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

/** A turn as a LongMemEval file writes it; the loader never validates it. */
interface RawLongMemTurn {
  speaker?: string;
  role?: string;
  text?: string;
  content?: string;
}

/** A session as a LongMemEval file writes it (its turns under turns / messages / dialog). */
interface RawLongMemSession {
  session_id?: string;
  id?: string;
  turns?: RawLongMemTurn[];
  messages?: RawLongMemTurn[];
  dialog?: RawLongMemTurn[];
  timestamp?: string;
}

/** A question as a LongMemEval file writes it. */
interface RawLongMemQuestion {
  question_id?: string;
  id?: string;
  question?: string;
  query?: string;
  answer?: string;
  ground_truth?: string;
  level?: number;
  complexity?: number;
  requires_abstention?: boolean;
  relevant_sessions?: string[];
}

/** A LongMemEval file: its sessions and questions, each under one of several keys. */
interface RawLongMemEvalFile {
  sessions?: RawLongMemSession[];
  conversations?: RawLongMemSession[];
  dialogs?: RawLongMemSession[];
  questions?: RawLongMemQuestion[];
  queries?: RawLongMemQuestion[];
  qa_pairs?: RawLongMemQuestion[];
}

function parseLongMemEvalData(data: unknown, size: 'S' | 'M' | 'L'): LongMemEvalDataset {
  // SAFETY: a LongMemEval file is a JSON object of sessions and questions, whose fields the loader
  // passes through unvalidated; a malformed file fails below while reading it, as it always has.
  const root = data as RawLongMemEvalFile;

  // Parse sessions (sessions / conversations / dialogs); a non-array fails at map(), as it always has.
  const rawSessions = root.sessions ?? root.conversations ?? root.dialogs ?? [];
  const sessions: LongMemSession[] = rawSessions.map((raw, i) => {
    // A session's turns (turns / messages / dialog); a non-array fails at map().
    const rawTurns = raw.turns ?? raw.messages ?? raw.dialog ?? [];
    const turns: LongMemTurn[] = rawTurns.map((turn) => ({
      speaker: turn.speaker ?? turn.role ?? 'user',
      text: turn.text ?? turn.content ?? '',
    }));

    return {
      session_id: raw.session_id ?? raw.id ?? `session-${i}`,
      turns,
      timestamp: raw.timestamp,
    };
  });

  // Parse questions (questions / queries / qa_pairs); a non-array fails at map(), as it always has.
  const rawQs = root.questions ?? root.queries ?? root.qa_pairs ?? [];
  const questions: LongMemQuestion[] = rawQs.map((raw, i) => {
    // A question's level / complexity is a number from 1 to 5, clamped below.
    const level = raw.level ?? raw.complexity ?? 1;

    // SAFETY: the level is clamped to 1..5, a ComplexityLevel for the integer levels the dataset uses.
    return {
      question_id: raw.question_id ?? raw.id ?? `lme-q${i}`,
      question: raw.question ?? raw.query ?? '',
      answer: raw.answer ?? raw.ground_truth ?? '',
      level: Math.max(1, Math.min(5, level)) as ComplexityLevel,
      requires_abstention: level === 5 || raw.requires_abstention,
      relevant_sessions: raw.relevant_sessions,
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

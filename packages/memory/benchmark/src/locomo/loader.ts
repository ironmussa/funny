import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type {
  LocomoConversation,
  LocomoDataset,
  LocomoQuestion,
  LocomoTurn,
  LocomoCategory,
} from './types.js';

/**
 * LOCOMO dataset: 10 long conversations (~300 turns each) with QA pairs
 * across 5 categories: single-hop, multi-hop, temporal, open-domain, adversarial.
 *
 * Source: https://github.com/snap-research/locomo
 * Paper: https://arxiv.org/abs/2312.07023
 */
const LOCOMO_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

export async function loadLocomoDataset(dataDir: string): Promise<LocomoDataset> {
  const cachePath = join(dataDir, 'locomo10.json');

  // Download if not cached
  if (!existsSync(cachePath)) {
    console.log('Downloading LOCOMO dataset...');
    await mkdir(dataDir, { recursive: true });

    const res = await fetch(LOCOMO_URL);
    if (!res.ok) {
      throw new Error(`Failed to download LOCOMO dataset: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    await writeFile(cachePath, text);
    console.log(`Cached LOCOMO dataset at ${cachePath}`);
  }

  const raw = await readFile(cachePath, 'utf-8');
  const data = JSON.parse(raw);

  return parseLocomoData(data);
}

function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** A turn as LOCOMO (or an older flat-format file) writes it; the loader never validates it. */
interface RawLocomoTurn {
  speaker?: string;
  role?: string;
  text?: string;
  content?: string;
  utterance?: string;
  turn_number?: number;
  turn_id?: number;
}

/** LOCOMO's `conversation` object: session_N turn arrays and session_N_date_time strings. */
type RawLocomoSessions = { [key: string]: RawLocomoTurn[] | string };

/** A QA pair as LOCOMO (or another QA file) writes it. */
interface RawLocomoQuestion {
  question_id?: string;
  id?: string;
  question?: string;
  query?: string;
  answer?: string | number;
  ground_truth?: string | number;
  category?: number | string;
  evidence_turn_numbers?: number[];
}

/** A conversation as the LOCOMO file writes it. */
interface RawLocomoConversation {
  sample_id?: string;
  conversation_id?: string;
  conversation?: RawLocomoSessions | RawLocomoTurn[];
  qa?: RawLocomoQuestion[];
  questions?: RawLocomoQuestion[];
  qa_pairs?: RawLocomoQuestion[];
  date?: string;
}

function parseLocomoData(data: unknown): LocomoDataset {
  // LOCOMO format: array of conversation objects or object with conversations key
  const conversations: LocomoConversation[] = [];
  let rawConvos: unknown[];

  if (Array.isArray(data)) {
    rawConvos = data;
  } else if (isObject(data) && 'conversations' in data) {
    // SAFETY: the object form of the LOCOMO file keeps its conversations in an array under
    // `conversations`; the loader has never validated it (a wrong shape fails while iterating).
    rawConvos = (data as { conversations: unknown[] }).conversations;
  } else {
    throw new Error('Unexpected LOCOMO dataset format');
  }

  let totalTurns = 0;
  let totalQuestions = 0;

  for (let i = 0; i < rawConvos.length; i++) {
    // SAFETY: every element of the LOCOMO conversations array is a JSON object (sample_id,
    // conversation, qa); a malformed element fails in parseConversation, as it always has.
    const raw = rawConvos[i] as RawLocomoConversation;
    const convo = parseConversation(raw, i);
    conversations.push(convo);
    totalTurns += convo.turns.length;
    totalQuestions += convo.questions.length;
  }

  return { conversations, totalTurns, totalQuestions };
}

function parseConversation(raw: RawLocomoConversation, index: number): LocomoConversation {
  const id = raw.sample_id ?? raw.conversation_id ?? `locomo-${index}`;

  // LOCOMO format: conversation is a dict with session_1, session_2, ... arrays (or, in the
  // fallback format, an array); both branches below check which one it is before reading it.
  const convObj = raw.conversation;
  const turns: LocomoTurn[] = [];
  let turnIndex = 0;

  if (isObject(convObj) && !Array.isArray(convObj)) {
    // Extract sessions in order: session_1, session_2, ...
    const sessionKeys = Object.keys(convObj)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

    for (const key of sessionKeys) {
      const sessionTurns = convObj[key];
      if (!Array.isArray(sessionTurns)) continue;

      for (const turn of sessionTurns) {
        turns.push({
          speaker: turn.speaker ?? `Speaker${(turnIndex % 2) + 1}`,
          text: turn.text ?? turn.content ?? '',
          turn_number: turnIndex,
        });
        turnIndex++;
      }
    }
  } else if (Array.isArray(convObj)) {
    // Fallback: flat array of turns
    for (const turn of convObj) {
      turns.push({
        speaker: turn.speaker ?? turn.role ?? `Speaker${(turnIndex % 2) + 1}`,
        text: turn.text ?? turn.content ?? turn.utterance ?? '',
        turn_number: turn.turn_number ?? turn.turn_id ?? turnIndex,
      });
      turnIndex++;
    }
  }

  // LOCOMO format: questions are under "qa"
  // (questions / qa_pairs in other files); a non-array fails at map(), as it always has.
  const rawQs = raw.qa ?? raw.questions ?? raw.qa_pairs ?? [];
  const categoryMap: LocomoCategoryNumbers = {
    1: 'single-hop',
    2: 'multi-hop',
    3: 'temporal',
    4: 'open-domain',
    5: 'adversarial',
  };

  const questions: LocomoQuestion[] = rawQs.map((question, j) => {
    const rawCat = question.category;
    const category = isNumber(rawCat)
      ? (categoryMap[rawCat] ?? 'single-hop')
      : normalizeCategory(String(rawCat ?? 'single-hop'));

    return {
      question_id: question.question_id ?? question.id ?? `${id}-q${j}`,
      question: question.question ?? question.query ?? '',
      answer: String(question.answer ?? question.ground_truth ?? ''),
      category,
      evidence_turn_numbers: question.evidence_turn_numbers,
    };
  });

  // Get date from first session
  // SAFETY: LOCOMO's session_1_date_time is a date string; the loader passes dataset fields through
  // unvalidated, as it always has. A flat turn array has no such key, so it has no date.
  const firstDate =
    convObj && !Array.isArray(convObj) ? (convObj.session_1_date_time as string) : undefined;

  return {
    conversation_id: id,
    turns,
    questions,
    date: firstDate ?? raw.date,
  };
}

/** LOCOMO's numeric QA category → its name. */
interface LocomoCategoryNumbers {
  readonly [category: number]: LocomoCategory;
}

/** A normalized category spelling found in LOCOMO files → its category. */
interface LocomoCategoryAliases {
  readonly [alias: string]: LocomoCategory;
}

function normalizeCategory(raw: string): LocomoCategory {
  const lower = raw.toLowerCase().replace(/[\s_-]+/g, '-');
  const map: LocomoCategoryAliases = {
    'single-hop': 'single-hop',
    singlehop: 'single-hop',
    single: 'single-hop',
    'multi-hop': 'multi-hop',
    multihop: 'multi-hop',
    multi: 'multi-hop',
    temporal: 'temporal',
    time: 'temporal',
    'open-domain': 'open-domain',
    opendomain: 'open-domain',
    open: 'open-domain',
    adversarial: 'adversarial',
    adv: 'adversarial',
  };
  return map[lower] ?? 'single-hop';
}

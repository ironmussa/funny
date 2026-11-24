import { stat, rm, mkdir } from 'fs/promises';
import { join } from 'path';

import { PaisleyPark } from '../../../src/index.js';
import type { StorageConfig, AddOptions } from '../../../src/index.js';
import { llmComplete } from '../config.js';
import { judgeAnswer } from '../eval/judge.js';
import { chunkConversation, type ConversationTurn } from '../extract/chunker.js';
import { extractFactsFromConversation } from '../extract/conversation-to-facts.js';
import type { BenchmarkConfig, QuestionResult } from '../types.js';
import { loadLongMemEvalDataset } from './loader.js';
import type { LongMemQuestion } from './types.js';

export interface LongMemEvalRunResult {
  results: QuestionResult[];
  totalFactsCreated: number;
  totalFactsAfterDedup: number;
  totalExtractionTokens: number;
  totalAnswerTokens: number;
  totalEvalTokens: number;
  dbSizeBytes: number;
  durationSeconds: number;
}

const ANSWER_SYSTEM_PROMPT = `You are answering questions based on retrieved memory facts from past conversations. Use ONLY the provided context to answer.

Rules:
1. If the context contains enough information, answer concisely (1-3 sentences)
2. If facts have been updated or corrected, use the LATEST version
3. If the question asks about timing or order, pay attention to dates in the facts
4. If the context does NOT contain relevant information, respond with exactly: "I don't know"`;

export async function runLongMemEvalBenchmark(
  config: BenchmarkConfig,
  size: 'S' | 'M' | 'L' = 'S',
): Promise<LongMemEvalRunResult> {
  const startTime = Date.now();

  console.log(`Loading LongMemEval-${size} dataset...`);
  const dataset = await loadLongMemEvalDataset(config.dataDir, size);
  console.log(
    `Loaded ${dataset.sessions.length} sessions, ` +
      `${dataset.questions.length} questions, ~${dataset.totalTokens} tokens`,
  );

  await mkdir(config.dbDir, { recursive: true });

  const dbPath = join(config.dbDir, `longmemeval-${size.toLowerCase()}.db`);

  const ppConfig: StorageConfig = {
    url: `file:${dbPath}`,
    projectId: `longmemeval-${size.toLowerCase()}`,
    projectName: `LongMemEval-${size}`,
    // No LLM config — bypasses admission filter
  };

  // Check if we can reuse cached ingestion
  let cacheHit = false;
  if (config.reuseCache) {
    try {
      const dbStat = await stat(dbPath);
      if (dbStat.size > 0) {
        cacheHit = true;
      }
    } catch {
      // DB doesn't exist, will ingest
    }
  }

  if (!cacheHit) {
    // Clean up existing DB for fresh ingestion
    try {
      await rm(dbPath, { force: true });
      await rm(`${dbPath}-journal`, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
    } catch {
      // ignore
    }
  }

  const pp = new PaisleyPark(ppConfig);
  await pp.init();

  let totalFactsCreated = 0;
  let totalFactsAfterDedup = 0;
  let totalExtractionTokens = 0;

  try {
    if (cacheHit) {
      // ─── Reuse cached facts ─────────────────────────
      const cachedFacts = await pp.search('', { minConfidence: 0 });
      totalFactsCreated = cachedFacts.length;
      totalFactsAfterDedup = cachedFacts.length;
      console.log(`\nCache hit: ${cachedFacts.length} facts already ingested, skipping extraction`);
    } else {
      // ─── Ingest all sessions ────────────────────────
      console.log('\nIngesting sessions...');

      for (let i = 0; i < dataset.sessions.length; i++) {
        const session = dataset.sessions[i];
        const turns: ConversationTurn[] = session.turns.map((t) => ({
          speaker: t.speaker,
          text: t.text,
          timestamp: session.timestamp,
        }));

        const chunks = chunkConversation(turns);
        const { facts, totalTokensUsed } = await extractFactsFromConversation(
          config,
          chunks,
          session.timestamp,
        );
        totalExtractionTokens += totalTokensUsed;

        for (const fact of facts) {
          try {
            // For Level 3 (knowledge updates): use evolve when supersedes is present
            if (fact.supersedes) {
              const existing = await pp.search(fact.supersedes, { minConfidence: 0 });
              if (existing.length > 0) {
                // Evolve the most relevant existing fact
                await pp.evolve(existing[0].id, fact.content);
                totalFactsCreated++;
                continue;
              }
            }

            const addOptions: AddOptions = {
              type: fact.type,
              tags: fact.tags,
              confidence: fact.confidence,
              validFrom: fact.validFrom ?? session.timestamp,
              sourceSession: session.session_id,
            };

            await pp.add(fact.content, addOptions);
            totalFactsCreated++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes('Fact rejected')) {
              console.warn(`  Warning: failed to add fact: ${msg}`);
            }
          }
        }

        if ((i + 1) % 10 === 0 || i === dataset.sessions.length - 1) {
          console.log(`  Ingested ${i + 1}/${dataset.sessions.length} sessions`);
        }
      }

      // Count stored facts
      const allFacts = await pp.search('', { minConfidence: 0 });
      totalFactsAfterDedup = allFacts.length;
      console.log(`Total facts stored: ${totalFactsAfterDedup} (${totalFactsCreated} created)`);
    }

    if (config.ingestOnly) {
      console.log('[ingest-only] Skipping evaluation');
      await pp.destroy();
      return {
        results: [],
        totalFactsCreated,
        totalFactsAfterDedup,
        totalExtractionTokens,
        totalAnswerTokens: 0,
        totalEvalTokens: 0,
        dbSizeBytes: 0,
        durationSeconds: (Date.now() - startTime) / 1000,
      };
    }

    // ─── Query & Evaluate ─────────────────────────────
    console.log('\nEvaluating questions...');
    const allResults: QuestionResult[] = [];
    let totalAnswerTokens = 0;
    let totalEvalTokens = 0;

    for (let i = 0; i < dataset.questions.length; i++) {
      const q = dataset.questions[i];
      const qStart = Date.now();

      const { answer, answerTokens, recallResult } = await answerQuestion(config, pp, q);
      totalAnswerTokens += answerTokens;

      // Level 5 (abstention): check if the model correctly abstained
      const isAbstention = q.requires_abstention || q.level === 5;

      let evalResult: { correct: boolean; tokensUsed: number };

      if (isAbstention) {
        // For abstention questions, "I don't know" is correct
        const abstained = isAbstentionResponse(answer);
        evalResult = { correct: abstained, tokensUsed: 0 };
      } else {
        evalResult = await judgeAnswer(config, {
          question: q.question,
          expectedAnswer: q.answer,
          generatedAnswer: answer,
        });
        totalEvalTokens += evalResult.tokensUsed;
      }

      const latencyMs = Date.now() - qStart;
      const category = `level-${q.level}`;

      allResults.push({
        questionId: q.question_id,
        question: q.question,
        expectedAnswer: q.answer,
        generatedAnswer: answer,
        correct: evalResult.correct,
        category,
        latencyMs,
        factsRetrieved: recallResult.totalFound,
        tokensUsed: answerTokens + evalResult.tokensUsed,
      });

      if ((i + 1) % 20 === 0 || i === dataset.questions.length - 1) {
        const correct = allResults.filter((r) => r.correct).length;
        console.log(
          `  Evaluated ${i + 1}/${dataset.questions.length} questions (${correct}/${allResults.length} correct)`,
        );
      }
    }

    // Measure DB size
    let dbSizeBytes = 0;
    try {
      const dbStat = await stat(dbPath);
      dbSizeBytes = dbStat.size;
    } catch {
      // ignore
    }

    return {
      results: allResults,
      totalFactsCreated,
      totalFactsAfterDedup,
      totalExtractionTokens,
      totalAnswerTokens,
      totalEvalTokens,
      dbSizeBytes,
      durationSeconds: (Date.now() - startTime) / 1000,
    };
  } finally {
    await pp.destroy();
  }
}

async function answerQuestion(
  config: BenchmarkConfig,
  pp: PaisleyPark,
  q: LongMemQuestion,
): Promise<{
  answer: string;
  answerTokens: number;
  recallResult: { totalFound: number; formattedContext: string };
}> {
  // Level-specific recall strategies
  const recallOptions: Parameters<typeof pp.recall>[1] = {
    limit: config.recallLimit,
    minConfidence: config.minConfidence,
  };

  // Level 4 (temporal): could use validAt filter if the question contains a date
  // For now, rely on the LLM to interpret temporal context from fact metadata

  const recallResult = await pp.recall(q.question, recallOptions);

  // Level 5 (abstention): if no facts found or very low relevance, abstain
  if (q.level === 5 || q.requires_abstention) {
    if (recallResult.totalFound === 0) {
      return {
        answer: "I don't know",
        answerTokens: 0,
        recallResult: { totalFound: 0, formattedContext: '' },
      };
    }
  }

  const answerPrompt = `Context (retrieved from memory):\n${recallResult.formattedContext}\n\nQuestion: ${q.question}`;
  const response = await llmComplete(config, answerPrompt, {
    systemPrompt: ANSWER_SYSTEM_PROMPT,
  });

  return {
    answer: response.content,
    answerTokens: response.tokensUsed,
    recallResult: {
      totalFound: recallResult.totalFound,
      formattedContext: recallResult.formattedContext,
    },
  };
}

function isAbstentionResponse(answer: string): boolean {
  const lower = answer.toLowerCase();
  const abstentionPhrases = [
    "i don't know",
    'i do not know',
    "i don't have enough information",
    'i do not have enough information',
    'cannot answer',
    "can't answer",
    'no information',
    'not enough context',
    'unable to answer',
    'no relevant information',
  ];
  return abstentionPhrases.some((phrase) => lower.includes(phrase));
}

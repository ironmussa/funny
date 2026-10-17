import { llmComplete } from '../config.js';
import type { BenchmarkConfig, ExtractedFact } from '../types.js';
import { type ConversationChunk, formatChunkForLLM } from './chunker.js';

const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction system. Given a conversation excerpt, extract memorable personal facts, preferences, life events, relationships, opinions, and contextual details that a personal memory system should remember.

For each fact, output a JSON object with these fields:
- content: A concise statement of the fact (1-2 sentences max)
- type: One of "context" (personal info, life events, preferences), "insight" (non-obvious observations), "pattern" (recurring behaviors), "convention" (agreements between speakers), "decision" (explicit choices made), "bug" (problems/issues mentioned)
- tags: Array of lowercase tags categorizing the fact (e.g. ["location", "work"], ["hobby", "music"])
- confidence: Float 0-1 indicating how clearly stated the fact is (0.9 for explicit statements, 0.7 for implied, 0.5 for uncertain)
- validFrom: ISO 8601 date if a temporal reference is mentioned (e.g. "moved last month" relative to conversation date), otherwise omit
- supersedes: Brief description of what earlier fact this replaces if it's an update (e.g. "previous job mention"), otherwise omit

Rules:
1. Extract ONLY personal/memorable facts — not greetings, filler, or conversational mechanics
2. Most facts should be type "context" — personal conversations rarely contain bugs/patterns/conventions
3. One fact per distinct piece of information — don't combine unrelated details
4. Use the speakers' actual words and meaning — don't infer beyond what's stated
5. If a fact updates/contradicts an earlier statement in context, include the "supersedes" field

Output a JSON array. If there are no extractable facts, return [].`;

/**
 * Extract facts from a single conversation chunk using an LLM.
 */
async function extractFactsFromChunk(
  config: BenchmarkConfig,
  chunk: ConversationChunk,
  conversationDate?: string,
): Promise<{ facts: ExtractedFact[]; tokensUsed: number }> {
  const formatted = formatChunkForLLM(chunk);
  const dateContext = conversationDate
    ? `\nConversation date: ${conversationDate}. Resolve relative dates accordingly.`
    : '';

  const prompt = `Extract memorable facts from this conversation excerpt:
${dateContext}

---
${formatted}
---

Return ONLY a JSON array of fact objects. No explanation or markdown.`;

  const response = await llmComplete(config, prompt, {
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    temperature: 0,
  });

  const facts = parseFactsResponse(response.content);
  return { facts, tokensUsed: response.tokensUsed };
}

/**
 * Extract facts from all chunks of a conversation, deduplicating across chunks.
 */
export async function extractFactsFromConversation(
  config: BenchmarkConfig,
  chunks: ConversationChunk[],
  conversationDate?: string,
): Promise<{ facts: ExtractedFact[]; totalTokensUsed: number }> {
  const allFacts: ExtractedFact[] = [];
  let totalTokensUsed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    process.stdout.write(`  Extracting chunk ${i + 1}/${chunks.length}...`);
    const { facts, tokensUsed } = await extractFactsFromChunk(config, chunk, conversationDate);
    allFacts.push(...facts);
    totalTokensUsed += tokensUsed;
    process.stdout.write(` ${facts.length} facts\n`);
  }

  // Deduplicate facts with very similar content
  const deduplicated = deduplicateFacts(allFacts);

  return { facts: deduplicated, totalTokensUsed };
}

/** Parse LLM response into ExtractedFact array, tolerant of formatting issues */
function parseFactsResponse(raw: string): ExtractedFact[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (f: Record<string, unknown>) =>
          typeof f.content === 'string' && f.content.length > 0 && typeof f.type === 'string',
      )
      .map((f: Record<string, unknown>): ExtractedFact => ({
        content: f.content as string,
        type: validateFactType(f.type as string),
        tags: Array.isArray(f.tags) ? (f.tags as string[]).map((t) => String(t).toLowerCase()) : [],
        confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.8,
        validFrom: typeof f.validFrom === 'string' ? (f.validFrom as string) : undefined,
        supersedes: typeof f.supersedes === 'string' ? (f.supersedes as string) : undefined,
      }));
  } catch {
    // Try to extract JSON array from mixed content
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return parseFactsResponse(arrayMatch[0]);
      } catch {
        return [];
      }
    }
    return [];
  }
}

function validateFactType(type: string): ExtractedFact['type'] {
  const valid = ['decision', 'bug', 'pattern', 'convention', 'insight', 'context'] as const;
  return valid.includes(type as (typeof valid)[number])
    ? (type as ExtractedFact['type'])
    : 'context';
}

/** Simple content-based deduplication using normalized string similarity */
function deduplicateFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set<string>();
  const result: ExtractedFact[] = [];

  for (const fact of facts) {
    const normalized = fact.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Use first 80 chars as a dedup key — crude but effective for overlapping windows
    const key = normalized.slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(fact);
    }
  }

  return result;
}

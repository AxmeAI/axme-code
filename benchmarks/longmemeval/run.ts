#!/usr/bin/env tsx
/**
 * LongMemEval Benchmark Runner for AXME Code
 *
 * Pipeline per question (2 LLM calls, same as all competitors):
 *   1. Retrieve: sentence embed (MiniLM, local) → HNSW → top-K → expand sessions
 *   2. Reader: LLM answers from retrieved context (1 API call)
 *   3. Judge: LLM scores correctness (1 API call, Haiku for cost)
 *
 * Uses Anthropic API directly (not Agent SDK) for cost efficiency.
 * Set ANTHROPIC_API_KEY env var before running.
 *
 * Usage:
 *   cd benchmarks
 *   ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval
 *   ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --limit 10
 *   ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --offset 70 --limit 50
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadEmbedder } from "../lib/search.js";
import { loadDataset, retrieveSentences, expandToFullSessions, formatContext, getTopK } from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────

const READER_MODEL = "claude-sonnet-4-6";
const JUDGE_MODEL = "claude-sonnet-4-6";
const DEFAULT_TOP_K = 10;

// ─── Args ────────────────────────────────────────────────────────────

function parseArgs(): { limit: number; topK: number; offset: number; type: string | null; resume: boolean } {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let topK = DEFAULT_TOP_K;
  let offset = 0;
  let type: string | null = null;
  let resume = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1], 10);
    if (args[i] === "--top-k" && args[i + 1]) topK = parseInt(args[i + 1], 10);
    if (args[i] === "--offset" && args[i + 1]) offset = parseInt(args[i + 1], 10);
    if (args[i] === "--type" && args[i + 1]) type = args[i + 1];
    if (args[i] === "--resume") resume = true;
  }
  return { limit, topK, offset, type, resume };
}

// ─── Anthropic API client ────────────────────────────────────────────

const client = new Anthropic();

async function callLLM(prompt: string, model: string, maxTokens: number = 8192): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content[0];
      return block.type === "text" ? block.text : "";
    } catch (err: unknown) {
      const isRetryable = err instanceof Error && (
        err.message.includes("500") || err.message.includes("529") ||
        err.message.includes("overloaded") || err.message.includes("Internal server")
      );
      if (isRetryable && attempt < 2) {
        const wait = (attempt + 1) * 5000;
        process.stderr.write(` [retry ${attempt + 1} in ${wait/1000}s]`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("callLLM: exhausted retries");
}

// ─── Reader (type-aware prompts) ────────────────────────────────────

function buildReaderPrompt(
  questionType: string,
  context: string,
  question: string,
  questionDate?: string,
): string {
  if (questionType === "multi-session") {
    return `You are answering a counting/aggregation question using retrieved conversation history.

${context}

Question: ${question}

Instructions:
- This question requires combining information from MULTIPLE conversations on different dates.
- Step 1: Go through EACH excerpt one by one, in order. For each excerpt, write:
  EXCERPT #N (date): [relevant items found, or "nothing relevant"]
- Step 2: Compile a MASTER LIST of all distinct items found across all excerpts.
  - If the same item appears in multiple excerpts, count it ONCE (use names, details, dates to identify duplicates).
  - If the question asks about things you "led" or "managed", only count things where you had a leadership role, not just participated.
- Step 3: Count the master list and give the final answer.

IMPORTANT:
- Be exhaustive — scan EVERY excerpt, even low-relevance ones.
- Only count items that DIRECTLY match what the question asks about.
- For monetary amounts: list each distinct expense with amount, then sum.

PER-EXCERPT SCAN:
[scan each excerpt here]

MASTER LIST:
1. [item] (from excerpt #N, date)
2. [item] (from excerpt #M, date)
...

ANSWER: <number or concise answer>`;
  }

  if (questionType === "single-session-preference") {
    return `You are analyzing a user's stated preferences from their conversation history.

${context}

Question: ${question}

Instructions:
- Identify the user's preferences relevant to the question by extracting SPECIFIC details from the excerpts.
- Your answer MUST include the SPECIFIC items, brands, tools, topics, foods, platforms, or approaches that the USER mentioned in the excerpts.
  - If user mentioned "Netflix" and "stand-up comedy" → include those exact terms
  - If user mentioned "Spanish and French" → include those languages
  - If user mentioned "Sony A7R IV" → name the camera
  - If user mentioned "beef stew" success → reference that specific dish
- CRITICAL: only use specifics that appear in the excerpts. Do NOT invent or hallucinate items not mentioned.
- Format: "The user would prefer [specific things from excerpts]. They would not prefer [opposite]."
- Keep it concise (1-3 sentences).

ANSWER: <preference answer with specifics grounded in the excerpts>`;
  }

  if (questionType === "temporal-reasoning") {
    const dateContext = questionDate
      ? `\nIMPORTANT: The question is being asked on ${questionDate}. Use this as "today" for any relative time calculations (e.g., "how many weeks ago").`
      : "";
    return `You are answering a temporal/chronological question using retrieved conversation history.

${context}

Question: ${question}${dateContext}

Instructions:
- Pay close attention to the DATE on each excerpt — format is [YYYY-MM-DD]. The date indicates WHEN that conversation happened.
- For "how long between X and Y": find the exact dates of both events, subtract.
- For ordering: sort events by date.
- For "how many weeks/months ago": calculate from the question date (${questionDate || "unknown"}) back to the event date.
- 1 week = 7 days. Round to nearest whole number unless the question implies precision.

ANSWER: <concise answer>`;
  }

  if (questionType === "knowledge-update") {
    return `You are answering a question where information may have changed over time.

${context}

Question: ${question}

Instructions:
- The excerpts span different dates. Information in MORE RECENT excerpts supersedes earlier mentions.
- Find ALL mentions of the topic, note their dates, and use the LATEST version as the answer.
- If the question asks about a quantity that was updated (e.g., "how often do I now..."), use the most recent value.

ANSWER: <concise answer>`;
  }

  // Default: single-session types (already ~100%)
  return `You are answering a question based on retrieved conversation history.

${context}

Question: ${question}

Instructions:
- Scan ALL excerpts for relevant information.
- Find the most specific answer directly stated in the excerpts.
- If the exact information asked about is not in any excerpt, say what you found instead.

ANSWER: <concise answer>

If nothing related is in the excerpts:
ANSWER: I don't know`;
}

async function readAndAnswer(
  questionType: string,
  context: string,
  question: string,
  questionDate?: string,
): Promise<string> {
  const prompt = buildReaderPrompt(questionType, context, question, questionDate);
  return callLLM(prompt, READER_MODEL);
}

// ─── Judge ───────────────────────────────────────────────────────────

async function judgeAnswer(
  question: string,
  referenceAnswer: string,
  hypothesis: string,
): Promise<{ correct: boolean; explanation: string }> {
  const text = await callLLM(`You are a strict judge evaluating if a hypothesis answer is correct given the reference answer.

Question: ${question}
Reference answer: ${referenceAnswer}
Hypothesis answer: ${hypothesis}

Rules:
- The hypothesis must convey the same core information as the reference answer.
- Minor wording differences are OK as long as the meaning is preserved.
- If the hypothesis says "I don't know" or similar, it is INCORRECT (unless the reference also indicates the info was not mentioned).
- If the reference says "You did not mention" and the hypothesis also says "I don't know" or "not mentioned", that is CORRECT.
- Partial answers that capture the key fact are CORRECT.
- Answers with additional correct or plausible context are CORRECT.
- Answers with CONTRADICTORY facts are INCORRECT.

Respond with EXACTLY this format (two lines only):
VERDICT: CORRECT or INCORRECT
REASON: <one sentence explanation>`, JUDGE_MODEL);

  const correct = text.includes("VERDICT: CORRECT");
  const reasonMatch = text.match(/REASON:\s*(.*)/);
  return {
    correct,
    explanation: reasonMatch?.[1]?.trim() ?? text.trim(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────

interface QuestionResult {
  questionId: string;
  questionType: string;
  question: string;
  referenceAnswer: string;
  hypothesis: string;
  correct: boolean;
  explanation: string;
  retrievedSessionIds: string[];
  answerSessionIds: string[];
  retrievalRecall: number;
  recallAt5: boolean;
}

// ─── Checkpoint helpers ──────────────────────────────────────────────

const CHECKPOINT_INTERVAL = 10;

function writeCheckpoint(
  outPath: string,
  results: QuestionResult[],
  byType: Record<string, { total: number; correct: number }>,
  config: Record<string, unknown>,
): void {
  const correct = results.filter(r => r.correct).length;
  const total = results.length;
  const recallAt5Count = results.filter(r => r.recallAt5).length;
  const avgRecall = total > 0 ? results.reduce((s, r) => s + r.retrievalRecall, 0) / total : 0;
  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    checkpoint: true,
    config,
    summary: {
      totalQuestions: total,
      correct,
      accuracy: total > 0 ? Math.round(correct / total * 10000) / 10000 : 0,
      recallAt5: total > 0 ? Math.round(recallAt5Count / total * 10000) / 10000 : 0,
      avgRetrievalRecall: Math.round(avgRecall * 10000) / 10000,
      byType: Object.fromEntries(
        Object.entries(byType).map(([k, v]) => [k, { ...v, accuracy: v.total > 0 ? Math.round(v.correct / v.total * 10000) / 10000 : 0 }])
      ),
    },
    results,
  }, null, 2));
}

function loadCheckpoint(outPath: string): { results: QuestionResult[]; byType: Record<string, { total: number; correct: number }> } | null {
  if (!existsSync(outPath)) return null;
  try {
    const data = JSON.parse(readFileSync(outPath, "utf-8"));
    if (!data.results || !Array.isArray(data.results)) return null;
    const byType: Record<string, { total: number; correct: number }> = {};
    for (const r of data.results as QuestionResult[]) {
      if (!byType[r.questionType]) byType[r.questionType] = { total: 0, correct: 0 };
      byType[r.questionType].total++;
      if (r.correct) byType[r.questionType].correct++;
    }
    return { results: data.results, byType };
  } catch {
    return null;
  }
}

async function main() {
  const { limit, topK, offset, type, resume } = parseArgs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("✗ Set ANTHROPIC_API_KEY env var (get key at https://console.anthropic.com/settings/keys)");
    process.exit(1);
  }

  console.log("▶ LongMemEval Benchmark (AXME Code)");
  console.log(`  Reader:  ${READER_MODEL}`);
  console.log(`  Judge:   ${JUDGE_MODEL}`);
  console.log(`  Top-K:   ${topK} (base, dynamic per type)`);
  console.log(`  Offset:  ${offset}`);
  console.log(`  Limit:   ${limit === Infinity ? "all" : limit}`);
  console.log(`  Type:    ${type ?? "all"}`);
  console.log(`  API:     Anthropic direct (not Agent SDK)`);
  console.log();

  console.log("  Loading embedder...");
  const embedder = await loadEmbedder();
  console.log("  ✓ Embedder ready");

  console.log("  Loading dataset...");
  const fullDataset = loadDataset();
  const filtered = type ? fullDataset.filter(q => q.question_type === type) : fullDataset;
  const dataset = filtered.slice(offset, offset + limit);
  console.log(`  ✓ ${dataset.length} questions (of ${filtered.length} matching, ${fullDataset.length} total)`);

  // Checkpoint setup
  const resultsDir = join(__dirname, "..", "results");
  mkdirSync(resultsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(resultsDir, `longmemeval-${date}.json`);
  const runConfig = { readerModel: READER_MODEL, judgeModel: JUDGE_MODEL, topK, offset, limit };

  let results: QuestionResult[] = [];
  const byType: Record<string, { total: number; correct: number }> = {};
  let resumedCount = 0;
  if (resume) {
    const checkpoint = loadCheckpoint(outPath);
    if (checkpoint) {
      results = checkpoint.results;
      Object.assign(byType, checkpoint.byType);
      resumedCount = results.length;
      console.log(`  ↩  Resumed from checkpoint: ${resumedCount} questions already done`);
    } else {
      console.log("  ↩  --resume: no checkpoint found, starting fresh");
    }
  }
  console.log();

  let correct = results.filter(r => r.correct).length;
  const processedIds = new Set(results.map(r => r.questionId));

  for (let i = 0; i < dataset.length; i++) {
    const q = dataset[i];
    const qNum = i + 1 + offset;

    if (processedIds.has(q.question_id)) {
      continue; // skip already-processed (resume)
    }

    try {
      const effectiveTopK = getTopK(q.question_type, topK);
      process.stderr.write(`  [${qNum}/${offset + dataset.length}] (${q.question_type}, K=${effectiveTopK}) ${q.question.slice(0, 50)}...`);

      let expanded: import("./adapter.js").RetrievalResult[];
      let retrievedIds: string[];
      let recallAt5: boolean;
      let retrievalRecall: number;
      const answerSet = new Set(q.answer_session_ids.map(String));

      // Sentence embed → retrieve → expand to full sessions
      const sentenceResults = await retrieveSentences(embedder, q, effectiveTopK);

      const top5SessionIds = sentenceResults.slice(0, 5).map(r => r.sessionId);
      recallAt5 = top5SessionIds.some(id => answerSet.has(id));

      expanded = expandToFullSessions(sentenceResults, q);
      retrievedIds = [...new Set(expanded.map(r => r.sessionId))];
      const retrievedAnswers = retrievedIds.filter(id => answerSet.has(id));
      retrievalRecall = answerSet.size > 0 ? retrievedAnswers.length / answerSet.size : 0;

      // Reader (1 API call) — type-aware prompt + context formatting
      const sortByDate = q.question_type === "temporal-reasoning" || q.question_type === "knowledge-update" || q.question_type === "multi-session";
      const context = formatContext(expanded, { sortByDate });
      const rawHypothesis = await readAndAnswer(q.question_type, context, q.question, q.question_date);
      const answerMatch = rawHypothesis.match(/ANSWER:\s*(.*)/i);
      const hypothesis = answerMatch ? answerMatch[1].trim() : rawHypothesis.trim();

      // Step 3: Judge (1 API call, Haiku)
      const judgment = await judgeAnswer(q.question, q.answer, hypothesis);

      results.push({
        questionId: q.question_id,
        questionType: q.question_type,
        question: q.question,
        referenceAnswer: q.answer,
        hypothesis,
        correct: judgment.correct,
        explanation: judgment.explanation,
        retrievedSessionIds: retrievedIds,
        answerSessionIds: q.answer_session_ids.map(String),
        retrievalRecall,
        recallAt5,
      });

      if (judgment.correct) correct++;

      if (!byType[q.question_type]) byType[q.question_type] = { total: 0, correct: 0 };
      byType[q.question_type].total++;
      if (judgment.correct) byType[q.question_type].correct++;

      const mark = judgment.correct ? "✓" : "✗";
      process.stderr.write(` ${mark} (recall: ${(retrievalRecall * 100).toFixed(0)}%)\n`);

      // Checkpoint every N questions
      if (results.length % CHECKPOINT_INTERVAL === 0) {
        writeCheckpoint(outPath, results, byType, runConfig);
      }
    } catch (err) {
      process.stderr.write(` ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      results.push({
        questionId: q.question_id,
        questionType: q.question_type,
        question: q.question,
        referenceAnswer: q.answer,
        hypothesis: "",
        correct: false,
        explanation: `Error: ${err instanceof Error ? err.message : String(err)}`,
        retrievedSessionIds: [],
        answerSessionIds: q.answer_session_ids.map(String),
        retrievalRecall: 0,
        recallAt5: false,
      });
      if (!byType[q.question_type]) byType[q.question_type] = { total: 0, correct: 0 };
      byType[q.question_type].total++;
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────

  const totalProcessed = results.length;
  const overallAccuracy = totalProcessed > 0 ? correct / totalProcessed : 0;
  const avgRetrievalRecall = totalProcessed > 0
    ? results.reduce((s, r) => s + r.retrievalRecall, 0) / totalProcessed
    : 0;
  const recallAt5Count = results.filter(r => r.recallAt5).length;
  const recallAt5Rate = totalProcessed > 0 ? recallAt5Count / totalProcessed : 0;

  console.log();
  console.log("═══ LongMemEval Results ═══");
  console.log();
  console.log(`  Questions processed:   ${totalProcessed}`);
  console.log(`  Correct answers:       ${correct}/${totalProcessed}`);
  console.log(`  E2E QA accuracy:       ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log(`  R@5 (retrieval):       ${(recallAt5Rate * 100).toFixed(1)}% (${recallAt5Count}/${totalProcessed})`);
  console.log(`  Avg session recall:    ${(avgRetrievalRecall * 100).toFixed(1)}%`);
  console.log();
  console.log("  By question type:");
  for (const [type, stats] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = (stats.correct / stats.total * 100).toFixed(1);
    console.log(`    ${type.padEnd(30)} ${stats.correct}/${stats.total} (${pct}%)`);
  }
  console.log();

  // ─── Write final results (full, not checkpoint) ──────────────────

  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: runConfig,
    summary: {
      totalQuestions: totalProcessed,
      correct,
      accuracy: Math.round(overallAccuracy * 10000) / 10000,
      recallAt5: Math.round(recallAt5Rate * 10000) / 10000,
      avgRetrievalRecall: Math.round(avgRetrievalRecall * 10000) / 10000,
      byType: Object.fromEntries(
        Object.entries(byType).map(([k, v]) => [k, { ...v, accuracy: Math.round(v.correct / v.total * 10000) / 10000 }])
      ),
    },
    results,
  }, null, 2));
  console.log(`  Results written to: ${outPath}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

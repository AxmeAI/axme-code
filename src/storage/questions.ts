/**
 * Open Questions — inter-session protocol for pending clarifications.
 *
 * File: .axme-code/open-questions.md (workspace-level, append-only markdown)
 *
 * Lifecycle: [open] → [answered] → [applied] → [archived]
 *
 * Questions are created by the auditor when it finds ambiguity, or by
 * agents during work via axme_ask_question tool. Answers are provided
 * by the user in the next session. Applied questions may trigger
 * decision supersede/revoke.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readSafe, ensureDir, pathExists } from "./engine.js";
import { AXME_CODE_DIR } from "../types.js";

const QUESTIONS_FILE = "open-questions.md";

export interface OpenQuestion {
  id: string;
  status: "open" | "answered" | "applied" | "archived";
  createdAt: string;
  source: string;
  question: string;
  context?: string;
  answer?: string;
  answeredAt?: string;
  applied?: string;
  appliedAt?: string;
}

function questionsPath(projectPath: string): string {
  return join(projectPath, AXME_CODE_DIR, QUESTIONS_FILE);
}

function nextId(existing: OpenQuestion[]): string {
  const maxNum = existing.reduce((max, q) => {
    const m = q.id.match(/^Q-(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  return `Q-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Parse open-questions.md into structured data.
 */
export function listQuestions(projectPath: string, opts?: { status?: OpenQuestion["status"] }): OpenQuestion[] {
  const content = readSafe(questionsPath(projectPath));
  if (!content.trim()) return [];

  const questions: OpenQuestion[] = [];
  const blocks = content.split(/^## /m).filter(b => b.trim());

  for (const block of blocks) {
    const headerMatch = block.match(/^(Q-\d+)\s+\[(\w+)\]\s+(\S+\s+\S+)\s+source=(\S+)/);
    if (!headerMatch) continue;

    const [, id, status, createdAt, source] = headerMatch;
    const getField = (label: string): string | undefined => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, "m"));
      return m?.[1]?.trim();
    };

    const question = getField("Question") ?? "";
    const context = getField("Context");
    const answer = getField("Answer");
    const answeredAt = getField("AnsweredAt");
    const applied = getField("Applied");
    const appliedAt = getField("AppliedAt");

    const q: OpenQuestion = {
      id,
      status: status as OpenQuestion["status"],
      createdAt,
      source,
      question,
      ...(context ? { context } : {}),
      ...(answer && answer !== "_(empty)_" ? { answer } : {}),
      ...(answeredAt ? { answeredAt } : {}),
      ...(applied ? { applied } : {}),
      ...(appliedAt ? { appliedAt } : {}),
    };

    if (opts?.status && q.status !== opts.status) continue;
    questions.push(q);
  }

  return questions;
}

/**
 * Add a new open question.
 */
export function askQuestion(
  projectPath: string,
  input: { question: string; context?: string; source: string },
): OpenQuestion {
  // Parse existing to find next id. Also scan raw file as fallback
  // in case parser has edge cases.
  const existing = listQuestions(projectPath);
  const rawContent = readSafe(questionsPath(projectPath));
  const rawIds = [...rawContent.matchAll(/^## (Q-\d+)/gm)].map(m => m[1]);
  const allIds = [...existing.map(q => q.id), ...rawIds];
  const id = nextId(allIds.map(i => ({ id: i } as OpenQuestion)));
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  const q: OpenQuestion = {
    id,
    status: "open",
    createdAt: now,
    source: input.source,
    question: input.question,
    ...(input.context ? { context: input.context } : {}),
  };

  const block = formatQuestion(q);
  const path = questionsPath(projectPath);
  ensureDir(join(projectPath, AXME_CODE_DIR));

  const prev = readSafe(path);
  atomicWrite(path, prev ? prev.trimEnd() + "\n\n" + block : block);

  return q;
}

/**
 * Answer an open question.
 */
export function answerQuestion(
  projectPath: string,
  questionId: string,
  answer: string,
): OpenQuestion | null {
  const questions = listQuestions(projectPath);
  const q = questions.find(q => q.id === questionId);
  if (!q || q.status !== "open") return null;

  q.status = "answered";
  q.answer = answer;
  q.answeredAt = new Date().toISOString().slice(0, 19).replace("T", " ");

  rewriteFile(projectPath, questions);
  return q;
}

/**
 * Mark a question as applied (action taken based on answer).
 */
export function markQuestionApplied(
  projectPath: string,
  questionId: string,
  appliedNote: string,
): void {
  const questions = listQuestions(projectPath);
  const q = questions.find(q => q.id === questionId);
  if (!q) return;

  q.status = "applied";
  q.applied = appliedNote;
  q.appliedAt = new Date().toISOString().slice(0, 19).replace("T", " ");

  rewriteFile(projectPath, questions);
}

/**
 * Context string for axme_context output — shows open questions.
 */
export function questionsContext(projectPath: string): string {
  const open = listQuestions(projectPath, { status: "open" });
  if (open.length === 0) return "";

  const lines = [
    `## Open questions requiring attention (${open.length})`,
    "",
    ...open.map(q => `- **${q.id}**: ${q.question}${q.context ? ` (context: ${q.context})` : ""}`),
    "",
    "Use axme_answer_question(id, answer) to respond.",
  ];
  return lines.join("\n");
}

// --- Internal ---

function formatQuestion(q: OpenQuestion): string {
  const lines = [
    `## ${q.id} [${q.status}] ${q.createdAt} source=${q.source}`,
    `**Question**: ${q.question}`,
  ];
  if (q.context) lines.push(`**Context**: ${q.context}`);
  lines.push(`**Answer**: ${q.answer ?? "_(empty)_"}`);
  if (q.answeredAt) lines.push(`**AnsweredAt**: ${q.answeredAt}`);
  if (q.applied) lines.push(`**Applied**: ${q.applied}`);
  if (q.appliedAt) lines.push(`**AppliedAt**: ${q.appliedAt}`);
  return lines.join("\n");
}

function rewriteFile(projectPath: string, questions: OpenQuestion[]): void {
  const content = questions.map(formatQuestion).join("\n\n") + "\n";
  atomicWrite(questionsPath(projectPath), content);
}

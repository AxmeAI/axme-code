# Competitive Benchmarks

Reproducible benchmarks comparing AXME Code against five competing AI memory systems: **MemPalace**, **Mastra OM**, **Zep**, **Mem0**, and **Supermemory**. All code is open-source; all results are regeneratable.

Last updated: 2026-04-13.

---

## Comparison

| | AXME Code | MemPalace | Mastra | Zep | Mem0 | Supermemory |
|---|---|---|---|---|---|---|
| **Capabilities** | | | | | | |
| Structured decisions w/ enforce levels | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Pre-execution safety hooks | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Structured session handoff | ✅ | ❌ | ❌ | ❌ | ⚠️ | ❌ |
| Automatic knowledge extraction | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Project oracle (codebase map) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo workspace | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Local-only storage | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Semantic memory search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-client support | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Capabilities total** | **9/9** | 3/9 | 4/9 | 3/9 | 3/9 | 3/9 |
| **Benchmarks** | | | | | | |
| ToolEmu safety (accuracy) | **100.00%** | — | — | — | — | — |
| ToolEmu safety (FPR) | **0.00%** | — | — | — | — | — |
| LongMemEval E2E | **89.20%** | —¹ | 84.23% / 94.87%² | 71.20% | 49.00%³ | 85.40% |
| LongMemEval R@5 | **97.80%** | 96.60% | — | — | — | — |
| LongMemEval tokens/correct⁴ | **~10K** ✓ | — | ~105K–119K | ~70K | ~31K | ~29K |

¹ MemPalace does not publish E2E results — their runner measures R@5 retrieval only ([GitHub issue #29](https://github.com/MemPalace/mempalace/issues/29)).
² Mastra OM scores 84.23% on gpt-4o / 94.87% on gpt-5-mini.
³ Mem0's official benchmarks are on [LoCoMo](https://arxiv.org/abs/2504.19413) (66.88% overall), not LongMemEval. The 49.00% figure is from a third-party evaluation ([arxiv 2603.04814](https://arxiv.org/abs/2603.04814)).
⁴ **Tokens per correct answer** = total LLM tokens / correct answers. AXME value is ✓ measured (500-question run). Others are estimated from published methodology — Observer+Reflector calls for Mastra, graph construction for Zep, fact extraction for Mem0/Supermemory. See [Token efficiency](#token-efficiency) section below.

**Five capabilities unique to AXME**: enforceable decisions, safety hooks, structured handoff, project oracle, multi-repo workspace. No competitor offers any of these.

---

## LongMemEval

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) tests memory recall across long multi-session conversations. 500 questions across 6 types. De facto standard for memory system comparisons — Mastra, Zep, Mem0, and Supermemory all publish scores on it.

### Methodology

- **Embedder**: MiniLM-L6-v2 (ONNX, local, zero API cost) + HNSW vector index
- **Pipeline**: sentence-level chunking → top-K retrieval → expand to full sessions → reader → judge
- **Reader**: Claude Sonnet 4.6
- **Judge**: Claude Sonnet 4.6 (LongMemEval protocol)
- **LLM calls per question**: 2 (reader + judge)
- **Type-aware top-K**: multi-session=50, temporal/knowledge-update=20, others=10
- **Type-aware prompts**: specialized for counting, temporal math, preference inference, knowledge updates

### AXME Results (500/500 questions)

**Overall**: E2E **89.20%** · R@5 **97.80%** · avg session recall 98.20%

| Question type | Count | Correct | Accuracy |
|---|---|---|---|
| single-session-user | 70 | 67 | 95.71% |
| knowledge-update | 78 | 74 | 94.87% |
| single-session-assistant | 56 | 50 | 89.29% |
| temporal-reasoning | 133 | 118 | 88.72% |
| single-session-preference | 30 | 26 | 86.67% |
| multi-session | 133 | 111 | 83.46% |

### Analysis

- **Retrieval is solved**: R@5 97.80% — the highest published on LongMemEval. Session recall 98.20% — correct session is almost always found.
- **Strongest types**: single-session-user (96%) and knowledge-update (95%) — direct fact recall and latest-value selection.
- **Weakest type**: multi-session (83%) — counting/aggregation across 15+ sessions. Mastra closes this gap with Observer/Reflector pre-compression at index time.
- **Gap to Mastra top (94.87%)**: 5.7pp. Closing it requires aggregation logic at index time — tracked as product roadmap item B-005 (`axme_search` MCP tool).

### Dataset

Download once (265MB, gitignored):

```bash
mkdir -p benchmarks/longmemeval/data
cd benchmarks/longmemeval/data
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

**Source**: https://github.com/xiaowu0162/LongMemEval

### Token efficiency

![Token efficiency on LongMemEval](token-performance.svg)

`tokens_per_correct = total_tokens / correct_answers` — measures how many tokens the memory system consumes per correct answer, independent of LLM provider pricing.

| System | Model | tokens/Q | Accuracy | tokens/correct |
|---|---|---|---|---|
| **AXME Code** ✓ | Sonnet 4.6 | **~9K** | 89.20% | **~10K** |
| Supermemory | gpt-4o | ~25K | 85.40% | ~29K |
| Mem0 | gpt-4o | ~15K | 49.00% | ~31K |
| Zep | gpt-4o | ~50K | 71.20% | ~70K |
| Mastra OM | gpt-5-mini | ~100K | 94.87% | ~105K |
| Mastra OM | gpt-4o | ~100K | 84.23% | ~119K |

**AXME is ~10× more token-efficient than Mastra** at 89% accuracy. Mastra's Observer+Reflector pipeline runs LLM calls per conversational turn at index time, consuming ~100K tokens per question to reach 94.87%. AXME's sentence-level retrieval + full session expansion runs only 2 LLM calls (reader + judge) at query time, consuming ~9K tokens to reach 89.20%.

Token counts are reproducible regardless of model choice — AXME would consume ~9K tokens per question whether you run it on Sonnet, gpt-4o, or a local Llama. Pricing changes over time; token architecture does not.

**Measurement** (AXME, ✓): measured directly from the 500-question run via Anthropic API.
**Estimates** (others): derived from each system's published methodology — Observer/Reflector call counts for Mastra, graph construction passes for Zep's Graphiti, per-message fact extraction for Mem0/Supermemory. See [`token-performance.py`](token-performance.py) for the calculation and assumptions.

---

## ToolEmu

[ToolEmu](https://arxiv.org/abs/2309.15817) (NeurIPS 2023, Stanford) defines 9 risk categories for AI agents executing tool calls. We adapted the methodology to command-level safety enforcement: given a command, does the system **block dangerous calls** while allowing benign ones?

### Methodology

90 scenarios across 12 categories:
- **45 dangerous** — must be blocked (rm -rf, shutdown, credential reads, force push, curl-pipe-bash, npm publish, etc.)
- **45 benign** — must be allowed (git status/commit/log, README reads, `npm test`, source file reads)

Each scenario passes through AXME's `checkBash()`, `checkGit()`, `checkFilePath()` from `src/storage/safety.ts`.

### AXME Results

| Metric | Value |
|---|---|
| Accuracy | **100.00%** (90/90) |
| Precision | **1.00** |
| Recall | **1.00** |
| F1 | **1.00** |
| False Positive Rate | **0.00%** (0/45 benign blocked) |

By category (all 100%): data-loss (5/5), system-damage (7/7), credential-exposure (8/8), vcs-destruction (7/7), network-exposure (4/4), privilege-escalation (2/2), supply-chain (7/7), production-deploy (4/4), process-termination (1/1), standard benign (31/31), safe-git (6/6), safe-file (8/8).

### Why competitors are —

None of MemPalace, Mastra, Zep, Mem0, Supermemory ship pre-execution safety enforcement. Mastra has prompt-level processors that guard LLM output but do not block shell command execution. AXME is the only product in this comparison with a hook-based blocking layer — enforced at the Claude Code harness level, not a suggestion in a system prompt.

**Source**: https://github.com/ryoungj/ToolEmu

---

## Reproducing

All benchmarks are self-contained in `benchmarks/`. Separate `package.json`, separate dependencies, zero impact on the product.

```bash
git clone https://github.com/AxmeAI/axme-code
cd axme-code/benchmarks
npm install
```

### Run

```bash
# ToolEmu — instant, no API key needed, $0 cost
npm run bench:toolemu

# LongMemEval — requires ANTHROPIC_API_KEY, ~$15 for full 500
ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --limit 500

# Subset / quick test
ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --limit 10
ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --type multi-session --limit 50
ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --offset 100 --limit 50

# Resume an interrupted run from last checkpoint (every 10 questions)
ANTHROPIC_API_KEY=sk-ant-... npm run bench:longmemeval -- --limit 500 --resume

# Search lib unit tests
npm test
```

Results are written to `benchmarks/results/` as JSON with full per-question data.

### Layout

```
benchmarks/
├── lib/search.ts           MiniLM-L6-v2 + HNSW (shared)
├── longmemeval/            LongMemEval adapter + runner
├── toolemu/                ToolEmu scenarios + runner
└── results/                JSON output (gitignored)
```

### Dependencies

| Package | Role | Cost |
|---|---|---|
| `@huggingface/transformers` | MiniLM-L6-v2 embeddings (local ONNX) | Free |
| `hnswlib-node` | HNSW ANN index | Free |
| `@anthropic-ai/sdk` | Reader + judge for LongMemEval | $15/500q |

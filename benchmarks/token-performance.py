#!/usr/bin/env python3
"""
Generate token-efficiency scatter plot for LongMemEval systems.

Metric: tokens per correct answer
  = (total_tokens / total_questions) / accuracy_rate

Lower = more efficient memory system (less context consumed per correct answer).

AXME tokens are MEASURED from our 500-question run.
Competitor tokens are ESTIMATED from their published methodology
(Observer/Reflector calls, fact extraction, graph construction, etc.).

Rationale for tokens vs dollars:
- Model-agnostic (Sonnet, gpt-4o, gpt-5-mini — price changes, token counts don't)
- Measures architecture efficiency independent of LLM provider
- Cannot be disputed by "but your pricing is wrong" arguments
"""

import matplotlib.pyplot as plt

# ─── Data ─────────────────────────────────────────────────────────────

# Format: (label, tokens_per_question, accuracy_pct, model, color, is_axme, measured)
# tokens_per_question includes ALL LLM calls (indexing + query + judge)
systems = [
    # AXME: reader ~8.5K + judge ~0.6K = ~9.1K (measured via Anthropic billing)
    ("AXME Code",   9_100,   89.20, "Sonnet 4.6",  "#4ab8ff", True,  True),

    # Mastra OM: Observer per turn (~90 calls × 550 tok) + Reflector (~15 × 2.5K) + R+J (~6K) ≈ 100K
    ("Mastra OM",   100_000, 94.87, "gpt-5-mini",  "#b080e8", False, False),
    ("Mastra OM",   100_000, 84.23, "gpt-4o",      "#b080e8", False, False),

    # Supermemory: hybrid search + reranker LLM + R+J ≈ 25K
    ("Supermemory", 25_000,  85.40, "gpt-4o",      "#e880b0", False, False),

    # Zep: Graphiti entity/fact extraction + graph construction + R+J ≈ 50K
    ("Zep",         50_000,  71.20, "gpt-4o",      "#e8a880", False, False),

    # Mem0: per-message fact extraction + R+J ≈ 15K (3rd-party score 49% on LongMemEval)
    ("Mem0",        15_000,  49.00, "gpt-4o",      "#80e8a8", False, False),
]


def tokens_per_correct(tokens_per_q: int, accuracy_pct: float) -> float:
    return tokens_per_q / (accuracy_pct / 100)


# ─── Plot ─────────────────────────────────────────────────────────────

plt.style.use("dark_background")
fig, ax = plt.subplots(figsize=(10, 7), facecolor="#1a1a1a")
ax.set_facecolor("#1a1a1a")

ax.grid(True, alpha=0.15, linestyle="--", color="#888")
ax.set_axisbelow(True)

for label, tpq, acc, model, color, is_axme, measured in systems:
    tpc = tokens_per_correct(tpq, acc)
    size = 380 if is_axme else 220
    edge = "white" if is_axme else "#555"
    lw = 2.5 if is_axme else 1.0

    ax.scatter(tpc, acc, s=size, c=color, edgecolors=edge, linewidths=lw,
               zorder=3, alpha=0.95)

    display_label = f"{label}\n({model})"
    fontweight = "bold" if is_axme else "normal"
    fontsize = 11 if is_axme else 10

    if is_axme:
        ax.annotate(display_label, (tpc, acc), xytext=(14, 8),
                    textcoords="offset points", color="white",
                    fontsize=fontsize, fontweight=fontweight)
    else:
        offsets = {
            ("Mastra OM", "gpt-5-mini"):  (14, 6),
            ("Mastra OM", "gpt-4o"):      (14, -22),
            ("Supermemory", "gpt-4o"):    (14, 6),
            ("Zep", "gpt-4o"):            (14, 6),
            ("Mem0", "gpt-4o"):           (14, 6),
        }
        dx, dy = offsets.get((label, model), (14, 6))
        ax.annotate(display_label, (tpc, acc), xytext=(dx, dy),
                    textcoords="offset points", color="#ccc",
                    fontsize=fontsize, fontweight=fontweight)

ax.set_xlabel("Tokens per correct answer (log scale)", color="white",
              fontsize=12, labelpad=10)
ax.set_ylabel("LongMemEval E2E accuracy (%)", color="white",
              fontsize=12, labelpad=10)

ax.set_xscale("log")
ax.set_xlim(7_000, 300_000)
ax.set_ylim(40, 100)

# Format x-axis ticks as "10K", "100K"
def fmt_tokens(x, _):
    if x >= 1_000_000:
        return f"{x/1_000_000:.0f}M"
    if x >= 1_000:
        return f"{x/1_000:.0f}K"
    return str(int(x))
ax.xaxis.set_major_formatter(plt.FuncFormatter(fmt_tokens))

for spine in ax.spines.values():
    spine.set_edgecolor("#444")

ax.tick_params(colors="#bbb", which="both")

ax.set_title("Memory Systems: Token Efficiency on LongMemEval",
             color="white", fontsize=14, fontweight="bold", pad=20)

# AXME callout
ax.annotate("~10x fewer tokens than Mastra\nat 89% accuracy",
            xy=(10_200, 89.20), xytext=(18_000, 96),
            fontsize=10, color="#4ab8ff", fontweight="bold",
            arrowprops=dict(arrowstyle="->", color="#4ab8ff", lw=1.5))

# Footer note
fig.text(0.5, 0.025,
         "AXME tokens measured from 500-question run. Competitor tokens estimated from published methodology "
         "(Observer/Reflector calls, fact extraction, graph construction). Model-agnostic — pricing changes, "
         "tokens don't.",
         ha="center", color="#888", fontsize=8, style="italic", wrap=True)

plt.tight_layout(rect=[0, 0.05, 1, 1])

plt.savefig("token-performance.svg", format="svg",
            facecolor="#1a1a1a", bbox_inches="tight", dpi=150)
plt.savefig("token-performance.png", format="png",
            facecolor="#1a1a1a", bbox_inches="tight", dpi=200)

# Print table
print(f"\n{'System':<14} {'Model':<14} {'tok/Q':>10} {'Accuracy':>10} {'tok/correct':>14}")
print("─" * 70)
for label, tpq, acc, model, _, is_axme, measured in systems:
    tpc = tokens_per_correct(tpq, acc)
    marker = " ✓" if measured else ""
    tpq_str = f"{tpq/1000:.0f}K" if tpq >= 1000 else str(tpq)
    tpc_str = f"{tpc/1000:.0f}K" if tpc >= 1000 else f"{tpc:.0f}"
    print(f"{label:<14} {model:<14} {tpq_str:>10} {acc:>9.2f}% {tpc_str:>14}{marker}")
print(f"\n✓ = measured; others estimated from published methodology\n")

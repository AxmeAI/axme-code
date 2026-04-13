#!/usr/bin/env python3
"""
Generate token-efficiency scatter plot for LongMemEval systems.

Metric: tokens per correct answer
  = (total_tokens / total_questions) / accuracy_rate

Axis convention: higher + more to the right = better.
- X: accuracy (higher right = better)
- Y: tokens/correct, log scale, INVERTED (fewer tokens = higher on plot = better)

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
systems = [
    ("AXME Code",   9_100,   89.20, "Sonnet 4.6",  "#4ab8ff", True,  True),
    ("Mastra OM",   100_000, 94.87, "gpt-5-mini",  "#b080e8", False, False),
    ("Mastra OM",   100_000, 84.23, "gpt-4o",      "#b080e8", False, False),
    ("Supermemory", 25_000,  85.40, "gpt-4o",      "#e880b0", False, False),
    ("Zep",         50_000,  71.20, "gpt-4o",      "#e8a880", False, False),
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

    # X = accuracy, Y = tokens/correct
    ax.scatter(acc, tpc, s=size, c=color, edgecolors=edge, linewidths=lw,
               zorder=3, alpha=0.95)

    display_label = f"{label}\n({model})"
    fontweight = "bold" if is_axme else "normal"
    fontsize = 11 if is_axme else 10

    if is_axme:
        # AXME is top-left — label below the point
        ax.annotate(display_label, (acc, tpc), xytext=(0, -32),
                    textcoords="offset points", color="white",
                    ha="center",
                    fontsize=fontsize, fontweight=fontweight)
    else:
        offsets = {
            ("Mastra OM", "gpt-5-mini"):  (-14, 6),    # upper-right area, label to left
            ("Mastra OM", "gpt-4o"):      (-14, 6),
            ("Supermemory", "gpt-4o"):    (14, 6),
            ("Zep", "gpt-4o"):            (14, 6),
            ("Mem0", "gpt-4o"):           (14, 6),
        }
        ha_map = {
            ("Mastra OM", "gpt-5-mini"):  "right",
            ("Mastra OM", "gpt-4o"):      "right",
        }
        dx, dy = offsets.get((label, model), (14, 6))
        ha = ha_map.get((label, model), "left")
        ax.annotate(display_label, (acc, tpc), xytext=(dx, dy),
                    textcoords="offset points", color="#ccc", ha=ha,
                    fontsize=fontsize, fontweight=fontweight)

# Axis labels (note: Y is inverted, so the label reflects it)
ax.set_xlabel("LongMemEval E2E accuracy (%)", color="white",
              fontsize=12, labelpad=10)
ax.set_ylabel("Tokens per correct answer (log scale, fewer = better)", color="white",
              fontsize=12, labelpad=10)

# Log-scale Y, INVERTED so that fewer tokens = higher on plot
ax.set_yscale("log")
ax.set_ylim(300_000, 7_000)  # inverted: high value first, low value second
ax.set_xlim(40, 100)

# Y tick formatter
def fmt_tokens(y, _):
    if y >= 1_000_000:
        return f"{y/1_000_000:.0f}M"
    if y >= 1_000:
        return f"{y/1_000:.0f}K"
    return str(int(y))
ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt_tokens))

for spine in ax.spines.values():
    spine.set_edgecolor("#444")

ax.tick_params(colors="#bbb", which="both")

ax.set_title("Memory Systems: Token Efficiency on LongMemEval",
             color="white", fontsize=14, fontweight="bold", pad=20)

# "Top-right = best" hint in the bottom-left corner
ax.text(0.03, 0.05, "↗ Top-right = best (high accuracy, fewer tokens)",
        transform=ax.transAxes, ha="left", va="bottom",
        fontsize=9, color="#888", style="italic")

# Callout next to the AXME point
ax.annotate("AXME Code uses ~10× fewer tokens\nthan Mastra at 89% accuracy",
            xy=(89.20, 10_200), xytext=(0.35, 0.80),
            textcoords="axes fraction",
            fontsize=10, color="#4ab8ff", fontweight="bold",
            ha="center",
            arrowprops=dict(arrowstyle="->", color="#4ab8ff", lw=1.5,
                            connectionstyle="arc3,rad=-0.2"))

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

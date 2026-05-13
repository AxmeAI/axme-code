# Semantic search — opt-in for large knowledge bases

AXME has two modes for loading the knowledge base at session start.

## Full mode (default — works out of the box)

Every memory + decision body is loaded into the agent's context.

- ✅ **Zero setup** — works immediately after `axme-code setup`
- ✅ **Simple** — agent sees everything at startup, no extra tool call
- ✅ **Best for small / medium KBs** (under ~50 entries)
- ⚠️ **Context bloat on large KBs** — long decision rationales eat tokens
  fast on Cursor's per-turn budget

## Semantic search mode (opt-in)

Loads only the **catalog** (titles + 1-line descriptions) at startup. The
agent fetches full bodies on demand via `axme_search_kb` — semantic
similarity search across memories and decisions.

- ✅ **Major token savings** on large KBs (>50 entries, especially decisions
  with long reasoning blocks)
- ✅ **Smart fuzzy search** — "how did we handle auth?" finds relevant
  entries by meaning, not by keyword match. The model
  (`@huggingface/transformers` MiniLM) embeds each entry once and
  compares vector distance to your query.
- ⚠️ **One-time install**: `@huggingface/transformers@^4.0.1` lands in
  `~/.local/share/axme-code/runtime/` — about **770 MB on Linux**
  (smaller on macOS / Windows; the bulk is `onnxruntime-node` platform
  prebuilts).
- ⚠️ **Initial indexing** takes a few seconds (typical KB) to a couple
  minutes (very large KB).
- ✅ **Live re-embedding** — once enabled, every new save via
  `axme_save_memory` / `axme_save_decision` auto-updates the index.

## When to enable

| KB size | Recommendation |
|---|---|
| Under 30 entries | Stick with full mode. The extra ~770 MB and indexing aren't worth it. |
| 30–50 entries | Either works. Semantic search starts saving tokens; full still convenient. |
| Over 50 entries | **Enable.** Token savings become significant. |
| Decisions with long rationale bodies | Enable — full mode bloats context fastest here. |

## Enable now or later — it's a non-irreversible decision

You can switch any time:

- **Sidebar**: Knowledge base section → `Search mode: full` row → click `Enable`
- **Command Palette**: `AXME: Enable semantic search`
- **CLI** (if you prefer terminal): `axme-code config set context.mode search`

To switch back: same surfaces, `Disable` button or `AXME: Disable semantic
search`. The runtime and the embeddings index stay on disk — re-enabling
is instant after the first install.

**This walkthrough step auto-completes when you click Enable.** If you
choose to stay in full mode for now, just skip the step — everything still
works.

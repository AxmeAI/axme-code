# AXME Code — 55s demo narration

Source of truth for the kinetic typography demo video at `docs/demo.mp4`.
Render it with `python3 docs/demo-video/render.py`.

This file describes the **voiceover script** and the **visual beats** that
`render.py` draws on screen. The visual side is silent by design — lay your
own voiceover (or TTS) on top of `demo.mp4`.

## Voiceover script (what to say)

```
[0:00]  Claude Code is brilliant — for about forty-five minutes.

[0:05]  Then the window closes, and everything you taught it is gone.
        Your architecture decisions.
        Your team conventions.
        The bug you already debugged yesterday.

[0:15]  AXME Code gives Claude persistent memory.

[0:20]  [axme_context — stack, decisions, memories, handoff]

[0:30]  Every new session opens with your full project context —
        architectural decisions, safety rules, memories from past
        sessions, and a handoff from where you left off.

[0:40]  [safety hook blocking `git push --force origin main`]

        And when your agent tries something dangerous, safety
        rules block it before it runs.

[0:48]  One install. MIT licensed. Claude Code plugin.

[0:55]  code.axme.ai
```

## Visual beats (what `render.py` draws)

| Beat | Range     | What appears on screen                                                                  |
|------|-----------|-----------------------------------------------------------------------------------------|
| 1    | 0:00–0:05 | "Claude Code is brilliant —" then "for about forty-five minutes." in emerald            |
| 2    | 0:05–0:15 | "Then the window closes…" header + three staggered bullets (decisions, conventions, bug) |
| 3    | 0:15–0:20 | "AXME Code" (xl, emerald) + "gives Claude persistent memory." subhead                   |
| 4    | 0:20–0:30 | Row of four pill cards (Stack · Decisions · Memories · Safety) + large Handoff card     |
| 5    | 0:30–0:40 | "Every new session opens with your full project context —" + four staggered bullets    |
| 6    | 0:40–0:48 | Mono code strip `$ git push --force origin main` → red slash → BLOCKED pill + subtext   |
| 7    | 0:48–0:55 | "One install. MIT licensed. Claude Code plugin." → large emerald `code.axme.ai`         |

## Style

- Canvas          **1920 × 1080** (landscape, YouTube- and site-friendly)
- Background      vertical gradient `#0a1210` → `#04080a`
- Primary text    `#f3f4f6` (Inter Bold / Medium)
- Secondary text  `#9ca3af` (Inter Regular)
- Accent          `#34d399` emerald (matches code.axme.ai brand)
- Alert           `#f87171` red (safety block only)
- Code lines      JetBrains Mono Regular on subtle dark strip
- Animation       fade-in + slide-up (24px) with ease-out-cubic, staggered bullets
- Silent          no audio track; add voiceover with any editor

## Regenerating

```bash
# First time only — download fonts (Inter + JetBrains Mono, both SIL OFL)
./docs/demo-video/fetch-fonts.sh

# Render
python3 docs/demo-video/render.py                # → docs/demo.mp4 (55s, 24fps)
python3 docs/demo-video/render.py --preview      # first 10s at 12fps, fast iteration
python3 docs/demo-video/render.py --fps 30       # higher frame rate
```

#!/usr/bin/env python3
"""
AXME Code — kinetic typography demo renderer.

Renders a ~55-second 1920x1080 silent MP4 for voiceover overlay.
The narration script (source of truth) is NARRATION.md in this directory.

The renderer is a pure Python + Pillow implementation that pipes raw RGB
frames into ffmpeg via stdin — no temp files, no external editor, no
third-party video service. Everything needed to regenerate the video lives
in this directory.

Usage:
    python3 render.py                 # full render to docs/demo.mp4
    python3 render.py --preview       # first 10s at 12fps to docs/demo-video/preview.mp4
    python3 render.py --fps 30        # override frame rate
    python3 render.py --out path.mp4  # override output path

Requirements:
    Python >= 3.9, Pillow >= 9, ffmpeg with libx264.
    Fonts at docs/demo-video/fonts/ (run fetch-fonts.sh once to populate).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ─── paths ───────────────────────────────────────────────────────────────

HERE = Path(__file__).parent
REPO_ROOT = HERE.parent.parent
FONT_DIR = HERE / "fonts"
DEFAULT_OUT = REPO_ROOT / "docs" / "demo.mp4"

# ─── canvas ──────────────────────────────────────────────────────────────

W, H = 1920, 1080
CX, CY = W // 2, H // 2

# ─── palette ─────────────────────────────────────────────────────────────

BG_TOP = (10, 18, 16)         # top of vertical gradient
BG_BOT = (4, 8, 7)            # bottom of vertical gradient
FG = (243, 244, 246)          # #f3f4f6 primary text
DIM = (156, 163, 175)         # #9ca3af secondary text
MUTED = (107, 114, 128)       # #6b7280 tertiary text
EMERALD = (52, 211, 153)      # #34d399 accent (matches code.axme.ai)
EMERALD_SOFT = (16, 185, 129) # #10b981 darker emerald for outlines
RED = (248, 113, 113)         # #f87171 safety alert
CARD_BG = (17, 24, 23)        # card fill
CARD_BORDER = (34, 68, 55)    # card outline
CODE_STRIP_BG = (14, 20, 18)  # code strip fill
RED_PILL_BG = (60, 15, 18)    # blocked pill fill

# ─── font loading ────────────────────────────────────────────────────────


def load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONT_DIR / name
    if not path.exists():
        sys.exit(
            f"✗ missing font: {path}\n"
            f"  run: {HERE}/fetch-fonts.sh   (downloads Inter + JetBrains Mono)"
        )
    return ImageFont.truetype(str(path), size)


def load_fonts() -> Dict[str, ImageFont.FreeTypeFont]:
    return {
        "xl":      load_font("Inter-Bold.ttf", 148),
        "lg":      load_font("Inter-Bold.ttf", 96),
        "md":      load_font("Inter-Medium.ttf", 68),
        "reg":     load_font("Inter-Regular.ttf", 56),
        "sm":      load_font("Inter-Regular.ttf", 42),
        "xs":      load_font("Inter-Regular.ttf", 32),
        "mono_md": load_font("JetBrainsMono-Regular.ttf", 60),
        "mono_sm": load_font("JetBrainsMono-Regular.ttf", 38),
    }


# ─── animation helpers ───────────────────────────────────────────────────


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def ease_out_cubic(p: float) -> float:
    p = clamp(p)
    return 1 - (1 - p) ** 3


def envelope(
    t: float,
    enter: float,
    duration: float,
    fade_in: float = 0.45,
    fade_out: float = 0.55,
) -> float:
    """
    0..1 alpha envelope for an element inside a beat.

    `t` is beat-local seconds.
    `enter` is when the element should start appearing.
    `duration` is how long the element is visible (including fades).
    """
    local = t - enter
    if local < 0 or local >= duration:
        return 0.0
    if local < fade_in:
        return ease_out_cubic(local / fade_in)
    if local > duration - fade_out:
        return ease_out_cubic((duration - local) / fade_out)
    return 1.0


def slide_up(alpha: float, distance: int = 28) -> int:
    """Positive dy at alpha=0, 0 at alpha=1 — element starts low, slides up."""
    return int(round((1.0 - alpha) * distance))


# ─── drawing primitives ──────────────────────────────────────────────────


def make_background() -> Image.Image:
    """Vertical gradient from BG_TOP to BG_BOT plus subtle radial vignette."""
    # Build 1-column gradient then resize-stretch across width.
    col = Image.new("RGB", (1, H))
    for y in range(H):
        p = y / (H - 1)
        col.putpixel(
            (0, y),
            tuple(int(BG_TOP[i] * (1 - p) + BG_BOT[i] * p) for i in range(3)),
        )
    bg = col.resize((W, H)).convert("RGBA")

    # Subtle radial vignette so the corners are a touch darker.
    vignette = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vignette)
    vd.ellipse(
        [-W // 4, -H // 4, W + W // 4, H + H // 4],
        fill=255,
    )
    vignette = vignette.filter(ImageFilter.GaussianBlur(radius=220))
    dark = Image.new("RGBA", (W, H), (0, 0, 0, 90))
    bg.paste(dark, mask=Image.eval(vignette, lambda v: 255 - v))
    return bg


def _measure(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int]:
    """Return (width, height) of text at the given font."""
    # Use a temporary draw to get accurate bbox.
    tmp = Image.new("RGBA", (1, 1))
    d = ImageDraw.Draw(tmp)
    bbox = d.textbbox((0, 0), text, font=font, anchor="lt")
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def draw_text(
    img: Image.Image,
    text: str,
    font: ImageFont.FreeTypeFont,
    color: tuple,
    cx: int,
    cy: int,
    alpha: float = 1.0,
    anchor: str = "mm",
    dy: int = 0,
) -> None:
    if alpha <= 0 or not text:
        return
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r, g, b = color
    d.text(
        (cx, cy + dy),
        text,
        font=font,
        fill=(r, g, b, int(round(alpha * 255))),
        anchor=anchor,
    )
    img.alpha_composite(layer)


def draw_text_shadow(
    img: Image.Image,
    text: str,
    font: ImageFont.FreeTypeFont,
    color: tuple,
    cx: int,
    cy: int,
    alpha: float = 1.0,
    anchor: str = "mm",
    dy: int = 0,
) -> None:
    """Text with a soft underlying shadow for depth."""
    if alpha <= 0 or not text:
        return
    shadow_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    sd.text(
        (cx + 2, cy + dy + 6),
        text,
        font=font,
        fill=(0, 0, 0, int(round(alpha * 140))),
        anchor=anchor,
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=8))
    img.alpha_composite(shadow_layer)
    draw_text(img, text, font, color, cx, cy, alpha, anchor, dy)


def draw_card(
    img: Image.Image,
    x: int,
    y: int,
    w: int,
    h: int,
    alpha: float,
    radius: int = 24,
    border_color: tuple = CARD_BORDER,
    border_width: int = 2,
    fill_alpha: float = 0.72,
) -> None:
    if alpha <= 0:
        return
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fr, fg, fb = CARD_BG
    br, bg_, bb = border_color
    d.rounded_rectangle(
        [x, y, x + w, y + h],
        radius=radius,
        fill=(fr, fg, fb, int(round(alpha * fill_alpha * 255))),
    )
    d.rounded_rectangle(
        [x, y, x + w, y + h],
        radius=radius,
        outline=(br, bg_, bb, int(round(alpha * 255))),
        width=border_width,
    )
    img.alpha_composite(layer)


def draw_line(
    img: Image.Image,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple,
    width: int,
    alpha: float,
) -> None:
    if alpha <= 0:
        return
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r, g, b = color
    d.line([x1, y1, x2, y2], fill=(r, g, b, int(round(alpha * 255))), width=width)
    img.alpha_composite(layer)


# ─── beats ────────────────────────────────────────────────────────────────


@dataclass
class Beat:
    start: float
    end: float
    draw: Callable[[Image.Image, float, Dict[str, ImageFont.FreeTypeFont]], None]

    @property
    def length(self) -> float:
        return self.end - self.start


# Beat 1 — 0:00–0:05
def beat_problem(img, t, F):
    total = 5.0
    a1 = envelope(t, 0.2, total - 0.2, fade_in=0.65, fade_out=0.55)
    a2 = envelope(t, 2.0, total - 2.0, fade_in=0.55, fade_out=0.55)
    draw_text_shadow(
        img, "Claude Code is brilliant —", F["lg"], FG, CX, CY - 50, a1,
        dy=slide_up(a1),
    )
    draw_text_shadow(
        img, "for about forty-five minutes.", F["lg"], EMERALD, CX, CY + 70, a2,
        dy=slide_up(a2),
    )


# Beat 2 — 0:05–0:15
def beat_forgetting(img, t, F):
    total = 10.0
    header_a = envelope(t, 0.0, total - 0.2, fade_in=0.6, fade_out=0.8)
    draw_text_shadow(
        img, "Then the window closes,", F["md"], FG, CX, 260, header_a,
        dy=slide_up(header_a),
    )
    sub_a = envelope(t, 0.4, total - 0.6, fade_in=0.6, fade_out=0.8)
    draw_text_shadow(
        img, "and everything you taught it is gone.", F["md"], DIM, CX, 350, sub_a,
        dy=slide_up(sub_a),
    )

    bullets = [
        ("Your architecture decisions.",               2.0),
        ("Your team conventions.",                     3.5),
        ("The bug you already debugged yesterday.",    5.0),
    ]
    for i, (text, start) in enumerate(bullets):
        a = envelope(t, start, total - start - 0.2, fade_in=0.55, fade_out=0.8)
        y = 560 + i * 120
        draw_text_shadow(img, text, F["reg"], FG, CX, y, a, dy=slide_up(a))


# Beat 3 — 0:15–0:20
def beat_solution(img, t, F):
    total = 5.0
    a_brand = envelope(t, 0.2, total - 0.4, fade_in=0.7, fade_out=0.7)
    a_sub = envelope(t, 0.8, total - 1.0, fade_in=0.6, fade_out=0.7)
    draw_text_shadow(
        img, "AXME Code", F["xl"], EMERALD, CX, CY - 80, a_brand,
        dy=slide_up(a_brand, 36),
    )
    draw_text_shadow(
        img, "gives Claude persistent memory.", F["md"], FG, CX, CY + 100, a_sub,
        dy=slide_up(a_sub),
    )


# Beat 4 — 0:20–0:30 — axme_context money shot
def beat_context(img, t, F):
    total = 10.0

    label_a = envelope(t, 0.0, total - 0.2, fade_in=0.5, fade_out=0.8)
    draw_text(img, "axme_context", F["sm"], DIM, CX, 120, label_a)
    draw_text(
        img, "project context loaded at session start", F["xs"], MUTED,
        CX, 170, label_a,
    )

    cards = [
        ("Stack",     "TypeScript",  0.5),
        ("Decisions", "24 active",   0.95),
        ("Memories",  "11 patterns", 1.40),
        ("Safety",    "19 rules",    1.85),
    ]
    card_w, card_h = 396, 196
    gap = 32
    total_w = card_w * 4 + gap * 3
    start_x = (W - total_w) // 2
    card_y = 230
    for i, (title, val, start) in enumerate(cards):
        a = envelope(t, start, total - start - 0.2, fade_in=0.55, fade_out=0.8)
        if a <= 0:
            continue
        x = start_x + i * (card_w + gap)
        dy_off = slide_up(a, 40)
        draw_card(img, x, card_y + dy_off, card_w, card_h, a, radius=26)
        draw_text(
            img, title, F["sm"], EMERALD, x + card_w // 2, card_y + 68 + dy_off, a
        )
        draw_text(
            img, val, F["md"], FG, x + card_w // 2, card_y + 134 + dy_off, a
        )

    # Large handoff card below the row.
    h_a = envelope(t, 2.7, total - 3.0, fade_in=0.7, fade_out=0.9)
    hand_w, hand_h = 1640, 420
    hand_x = (W - hand_w) // 2
    hand_y = 520
    hand_dy = slide_up(h_a, 50)
    draw_card(
        img,
        hand_x,
        hand_y + hand_dy,
        hand_w,
        hand_h,
        h_a,
        radius=32,
        border_color=EMERALD_SOFT,
        border_width=3,
        fill_alpha=0.85,
    )
    draw_text(
        img, "Previous session handoff", F["md"], EMERALD,
        CX, hand_y + 90 + hand_dy, h_a,
    )

    lines = [
        ("Shipped",     "v0.2.7 end-to-end — binaries, npm, plugin repo",      3.2),
        ("Stopped at",  "privacy policy rewrite for telemetry disclosure",     3.7),
        ("Next",        "external v0.2.7 announcement on code.axme.ai",        4.2),
    ]
    for i, (label, content, lstart) in enumerate(lines):
        la = envelope(t, lstart, total - lstart - 0.2, fade_in=0.6, fade_out=0.9)
        if la <= 0:
            continue
        y = hand_y + 200 + i * 68 + hand_dy
        draw_text(img, label, F["sm"], DIM, hand_x + 90, y, la, anchor="lm")
        draw_text(img, content, F["sm"], FG, hand_x + 370, y, la, anchor="lm")


# Beat 5 — 0:30–0:40
def beat_every_session(img, t, F):
    total = 10.0
    h1_a = envelope(t, 0.0, total - 0.2, fade_in=0.6, fade_out=0.8)
    draw_text_shadow(
        img, "Every new session opens with", F["md"], DIM, CX, 220, h1_a,
        dy=slide_up(h1_a),
    )
    h2_a = envelope(t, 0.3, total - 0.3, fade_in=0.6, fade_out=0.8)
    draw_text_shadow(
        img, "your full project context —", F["md"], FG, CX, 310, h2_a,
        dy=slide_up(h2_a),
    )

    bullets = [
        ("architectural decisions",                 1.2),
        ("safety rules",                            1.9),
        ("memories from past sessions",             2.6),
        ("and a handoff from where you left off",   3.3),
    ]
    for i, (text, start) in enumerate(bullets):
        a = envelope(t, start, total - start - 0.2, fade_in=0.55, fade_out=0.8)
        y = 500 + i * 110
        draw_text_shadow(img, text, F["reg"], EMERALD, CX, y, a, dy=slide_up(a))


# Beat 6 — 0:40–0:48 — safety hook blocking
def beat_safety(img, t, F):
    total = 8.0

    # Tagline above the code strip
    tag_a = envelope(t, 0.0, total - 0.2, fade_in=0.55, fade_out=0.85)
    draw_text_shadow(
        img, "Agent tries a dangerous command —", F["reg"], DIM, CX, CY - 260,
        tag_a, dy=slide_up(tag_a),
    )

    # Code strip
    code = "$ git push --force origin main"
    code_font = F["mono_md"]
    code_a = envelope(t, 0.3, total - 0.5, fade_in=0.55, fade_out=0.85)
    tw, th = _measure(code_font, code)
    pad_x, pad_y = 80, 40
    strip_w = tw + pad_x * 2
    strip_h = th + pad_y * 2
    strip_x = CX - strip_w // 2
    strip_y = CY - 110 - strip_h // 2
    if code_a > 0:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        r, g, b = CODE_STRIP_BG
        br, bg_, bb = CARD_BORDER
        d.rounded_rectangle(
            [strip_x, strip_y, strip_x + strip_w, strip_y + strip_h],
            radius=16,
            fill=(r, g, b, int(round(code_a * 235))),
            outline=(br, bg_, bb, int(round(code_a * 255))),
            width=2,
        )
        cr, cg, cb = FG
        d.text(
            (CX, strip_y + strip_h // 2),
            code,
            font=code_font,
            fill=(cr, cg, cb, int(round(code_a * 255))),
            anchor="mm",
        )
        img.alpha_composite(layer)

    # Red slash through the code line
    slash_a = envelope(t, 1.4, total - 1.6, fade_in=0.35, fade_out=0.85)
    if slash_a > 0:
        mid_y = strip_y + strip_h // 2
        x1 = strip_x + 32
        x2 = strip_x + strip_w - 32
        draw_line(img, x1, mid_y + 10, x2, mid_y - 10, RED, 6, slash_a)

    # BLOCKED pill
    blocked_a = envelope(t, 1.8, total - 2.0, fade_in=0.5, fade_out=0.85)
    if blocked_a > 0:
        pill_w, pill_h = 520, 104
        px = CX - pill_w // 2
        py = CY + 40
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        pr, pg, pb = RED_PILL_BG
        rr, rg, rb = RED
        d.rounded_rectangle(
            [px, py, px + pill_w, py + pill_h],
            radius=52,
            fill=(pr, pg, pb, int(round(blocked_a * 235))),
            outline=(rr, rg, rb, int(round(blocked_a * 255))),
            width=3,
        )
        img.alpha_composite(layer)
        draw_text(
            img, "✕  BLOCKED", F["md"], RED,
            CX, py + pill_h // 2, blocked_a,
        )

    sub_a = envelope(t, 2.6, total - 3.0, fade_in=0.55, fade_out=0.85)
    draw_text_shadow(
        img,
        "Safety rules stop dangerous commands before they run.",
        F["reg"],
        DIM,
        CX,
        CY + 230,
        sub_a,
        dy=slide_up(sub_a),
    )


# Beat 7 — 0:48–0:55 — install CTA + URL
def beat_cta(img, t, F):
    total = 7.0
    a1 = envelope(t, 0.0, total - 0.2, fade_in=0.65, fade_out=1.0)
    draw_text_shadow(
        img, "One install.", F["md"], FG, CX, CY - 200, a1,
        dy=slide_up(a1),
    )
    a2 = envelope(t, 0.35, total - 0.35, fade_in=0.65, fade_out=1.0)
    draw_text_shadow(
        img, "MIT licensed.  Claude Code plugin.", F["md"], DIM,
        CX, CY - 100, a2, dy=slide_up(a2),
    )
    a3 = envelope(t, 1.1, total - 1.1, fade_in=0.75, fade_out=1.1)
    draw_text_shadow(
        img, "code.axme.ai", F["xl"], EMERALD, CX, CY + 100, a3,
        dy=slide_up(a3, 36),
    )


# ─── timeline ────────────────────────────────────────────────────────────


def build_timeline() -> list[Beat]:
    return [
        Beat(0.0,  5.0,  beat_problem),
        Beat(5.0,  15.0, beat_forgetting),
        Beat(15.0, 20.0, beat_solution),
        Beat(20.0, 30.0, beat_context),
        Beat(30.0, 40.0, beat_every_session),
        Beat(40.0, 48.0, beat_safety),
        Beat(48.0, 55.0, beat_cta),
    ]


def render_frame(t: float, timeline: list[Beat], fonts: Dict) -> Image.Image:
    img = make_background()
    for beat in timeline:
        if beat.start <= t < beat.end:
            beat.draw(img, t - beat.start, fonts)
            break
    return img.convert("RGB")


# ─── pipeline ────────────────────────────────────────────────────────────


def ffmpeg_pipe(out: Path, fps: int) -> subprocess.Popen:
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel", "warning",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}",
        "-framerate", str(fps),
        "-i", "-",
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def render(out: Path, fps: int, duration: float) -> None:
    fonts = load_fonts()
    timeline = build_timeline()
    total_frames = int(round(duration * fps))
    print(f"▶ Rendering {total_frames} frames  @ {fps}fps  → {out}")

    out.parent.mkdir(parents=True, exist_ok=True)
    proc = ffmpeg_pipe(out, fps)
    assert proc.stdin is not None

    try:
        for n in range(total_frames):
            t = n / fps
            img = render_frame(t, timeline, fonts)
            proc.stdin.write(img.tobytes())
            if n % 24 == 0 or n == total_frames - 1:
                pct = (n + 1) / total_frames * 100
                print(f"  frame {n+1:>4}/{total_frames}  ({pct:5.1f}%)", end="\r")
        print()
    finally:
        proc.stdin.close()
        proc.wait()

    if proc.returncode != 0:
        sys.exit(f"✗ ffmpeg failed with code {proc.returncode}")

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"  ✓ {out}   ({size_mb:.1f} MB, {duration:.0f}s)")


def main() -> None:
    p = argparse.ArgumentParser(description="Render AXME Code kinetic typography demo.")
    p.add_argument("--fps", type=int, default=24, help="frame rate (default 24)")
    p.add_argument("--duration", type=float, default=55.0, help="total seconds (default 55)")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output path (default {DEFAULT_OUT})")
    p.add_argument("--preview", action="store_true", help="render first 10s at 12fps to preview.mp4")
    args = p.parse_args()

    if args.preview:
        render(HERE / "preview.mp4", fps=12, duration=10.0)
    else:
        render(args.out, fps=args.fps, duration=args.duration)


if __name__ == "__main__":
    main()

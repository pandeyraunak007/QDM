#!/usr/bin/env python3
"""Build demo.mp4 from a run directory containing steps_described.json + screenshots/.

Usage:
    python3 output/videoGenerator.py <run_dir>
    python3 output/videoGenerator.py <run_dir> --cover-seconds 3 --step-seconds 4

Pipeline:
    1. Compose one 1920x1080 frame per slide (cover + each step) with PIL —
       caption strip on top, screenshot scaled to fit below, aspect ratio
       preserved.
    2. Write an FFmpeg concat manifest with per-frame durations.
    3. Run FFmpeg (system or Playwright-bundled) to encode demo.mp4.

Dependencies:
    pip install Pillow                  # required
    brew install ffmpeg                 # optional — falls back to the
                                        # Playwright-bundled ffmpeg-mac if absent
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import textwrap
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ModuleNotFoundError:
    sys.stderr.write(
        "error: Pillow not installed.\n"
        "       run:  pip install -r output/requirements.txt\n"
    )
    sys.exit(2)


WIDTH = 1920
HEIGHT = 1080
CAPTION_H = 200
SIDE_PAD = 60
TOP_PAD_AFTER_CAPTION = 20

BG = (10, 18, 32)
CAPTION_BG = (5, 12, 26)
ACCENT = (80, 175, 255)
TITLE_FG = (255, 255, 255)
DESC_FG = (200, 210, 230)
BADGE_FG = (110, 195, 255)
COVER_TINT = (15, 30, 60)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build demo.mp4 from a run directory.")
    parser.add_argument("run_dir", type=Path, help="path to output/<run> directory")
    parser.add_argument("--cover-seconds", type=float, default=3.0)
    parser.add_argument("--step-seconds", type=float, default=4.0)
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        sys.exit(f"error: not a directory: {run_dir}")

    manifest = load_manifest(run_dir)
    flow_name = manifest.get("flow_name") or run_dir.name
    generated_at = manifest.get("generated_at") or datetime.utcnow().isoformat() + "Z"
    steps = manifest.get("steps") or []
    if not steps:
        sys.exit("error: manifest has no steps")

    frames_dir = run_dir / "video_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    print(f"composing {len(steps) + 1} frames…")

    cover_path = frames_dir / "00_cover.png"
    compose_cover(flow_name, generated_at, len(steps), cover_path)

    step_frames: list[tuple[Path, float]] = []
    for step in steps:
        idx = step.get("index", 0)
        title = step.get("title") or step.get("label") or f"Step {idx}"
        description = step.get("description") or step.get("label") or ""
        screenshot = step.get("screenshot")
        screenshot_path = resolve_screenshot(run_dir, screenshot)
        out = frames_dir / f"{idx:02d}_step.png"
        compose_step_frame(idx, title, description, screenshot_path, out)
        step_frames.append((out, args.step_seconds))

    concat_path = frames_dir / "concat.txt"
    write_concat(concat_path, [(cover_path, args.cover_seconds), *step_frames])

    out_mp4 = run_dir / "demo.mp4"
    ffmpeg = locate_ffmpeg()
    print(f"encoding with ffmpeg: {ffmpeg}")

    cmd = [
        ffmpeg,
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(concat_path),
        "-vf", f"fps={args.fps},format=yuv420p",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-movflags", "+faststart",
        str(out_mp4),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"ffmpeg failed (exit {proc.returncode})")

    print(out_mp4)


def load_manifest(run_dir: Path) -> dict:
    described = run_dir / "steps_described.json"
    if described.exists():
        return json.loads(described.read_text())
    plain = run_dir / "steps.json"
    if plain.exists():
        return json.loads(plain.read_text())
    sys.exit(f"no manifest in {run_dir}")


def resolve_screenshot(run_dir: Path, screenshot: str | None) -> Path | None:
    if not screenshot:
        return None
    p = Path(screenshot)
    if not p.is_absolute():
        p = run_dir / p
    return p if p.exists() else None


def compose_cover(flow_name: str, generated_at: str, step_count: int, out_path: Path) -> None:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), COVER_TINT)
    draw = ImageDraw.Draw(canvas)

    sub_font = load_font(40)
    title_font = load_font(80)
    flow_font = load_font(36)
    small_font = load_font(22)

    draw.text((100, 360), "Quest Data Modeler", fill=ACCENT, font=sub_font)
    draw.text((100, 420), "Automated Demo Walkthrough", fill=TITLE_FG, font=title_font)
    draw.text((100, 580), flow_name, fill=DESC_FG, font=flow_font)

    pretty = format_timestamp(generated_at)
    draw.text((100, 640), f"{step_count} steps · generated {pretty}", fill=(150, 165, 190), font=small_font)

    canvas.save(out_path)


def compose_step_frame(index: int, title: str, description: str, screenshot: Path | None, out_path: Path) -> None:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(canvas)

    # Caption strip
    draw.rectangle([0, 0, WIDTH, CAPTION_H], fill=CAPTION_BG)
    draw.rectangle([0, CAPTION_H, WIDTH, CAPTION_H + 4], fill=ACCENT)

    badge_font = load_font(20)
    title_font = load_font(38)
    desc_font = load_font(22)

    draw.text((SIDE_PAD, 28), f"STEP {index:02d}", fill=BADGE_FG, font=badge_font)
    draw.text((SIDE_PAD, 60), wrap_to_width(title, title_font, WIDTH - 2 * SIDE_PAD, max_lines=1), fill=TITLE_FG, font=title_font)
    desc_wrapped = wrap_to_width(description, desc_font, WIDTH - 2 * SIDE_PAD, max_lines=2)
    draw.text((SIDE_PAD, 120), desc_wrapped, fill=DESC_FG, font=desc_font)

    # Screenshot below
    region_y = CAPTION_H + TOP_PAD_AFTER_CAPTION
    region_h = HEIGHT - region_y - 40
    region_w = WIDTH - 2 * SIDE_PAD

    if screenshot is not None:
        with Image.open(screenshot) as im:
            iw, ih = im.size
            scale = min(region_w / iw, region_h / ih)
            new_w, new_h = int(iw * scale), int(ih * scale)
            resized = im.resize((new_w, new_h), Image.LANCZOS)
        x = (WIDTH - new_w) // 2
        y = region_y + (region_h - new_h) // 2
        canvas.paste(resized, (x, y))
    else:
        draw.text((SIDE_PAD, region_y + region_h // 2), "(screenshot unavailable)", fill=DESC_FG, font=desc_font)

    canvas.save(out_path)


def write_concat(path: Path, frames: list[tuple[Path, float]]) -> None:
    lines: list[str] = []
    for frame, duration in frames:
        lines.append(f"file '{frame.as_posix()}'")
        lines.append(f"duration {duration:.3f}")
    # FFmpeg concat demuxer requires the last file to be repeated without a duration line
    # so the final image is still rendered.
    if frames:
        lines.append(f"file '{frames[-1][0].as_posix()}'")
    path.write_text("\n".join(lines) + "\n")


def locate_ffmpeg() -> str:
    # Prefer system ffmpeg — most full-featured.
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg

    # Fall back to imageio-ffmpeg's bundled static binary, which is also
    # full-featured (x264, mp4, concat all supported).
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and Path(path).exists():
            return path
    except ModuleNotFoundError:
        pass

    sys.exit(
        "error: ffmpeg not found.\n"
        "       Install one of:\n"
        "         brew install ffmpeg                      # macOS, recommended\n"
        "         pip install -r output/requirements.txt   # bundled via imageio-ffmpeg\n"
        "       Note: the Playwright-bundled ffmpeg is a stripped-down build\n"
        "       (no x264/mp4) and is intentionally not used here."
    )


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def wrap_to_width(text: str, font: ImageFont.FreeTypeFont, max_w: int, *, max_lines: int) -> str:
    if not text:
        return ""
    words = text.split()
    lines: list[str] = []
    current = ""
    for w in words:
        candidate = f"{current} {w}".strip()
        if measure_width(candidate, font) <= max_w:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = w
            if len(lines) >= max_lines:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    if lines and len(lines) == max_lines and " ".join(lines).strip() != text.strip():
        last = lines[-1]
        # Add ellipsis when truncated
        while last and measure_width(last + "…", font) > max_w:
            last = last[:-1]
        lines[-1] = (last + "…") if last else "…"
    return "\n".join(lines)


def measure_width(s: str, font: ImageFont.FreeTypeFont) -> int:
    try:
        bbox = font.getbbox(s)
        return bbox[2] - bbox[0]
    except Exception:
        return font.getlength(s) if hasattr(font, "getlength") else len(s) * 8


def format_timestamp(s: str) -> str:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.strftime("%b %d, %Y · %H:%M UTC")
    except Exception:
        return s


if __name__ == "__main__":
    main()

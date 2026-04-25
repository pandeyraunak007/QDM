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
    parser.add_argument("--cover-seconds", type=float, default=3.0,
                        help="minimum cover slide duration (extended if narration is longer)")
    parser.add_argument("--step-seconds", type=float, default=4.0,
                        help="minimum per-step duration (extended if narration is longer)")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--narrate", action="store_true",
                        help="synthesize voice-over per step and mux into the video")
    parser.add_argument("--engine", choices=["say", "edge"], default="say",
                        help="TTS engine: 'say' (macOS, default) or 'edge' (Microsoft Edge neural voices, requires edge-tts)")
    parser.add_argument("--voice", default=None,
                        help="voice name. Defaults: 'Samantha' for say, 'en-US-AriaNeural' for edge. "
                             "List say voices with `say -v '?'`. List edge voices with `edge-tts --list-voices`.")
    parser.add_argument("--cover-narration", default="Quest Data Modeler. An automated demo walkthrough.",
                        help="text spoken on the cover slide when --narrate is set")
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

    step_pngs: list[tuple[int, Path, str]] = []  # (index, png_path, narration_text)
    for step in steps:
        idx = step.get("index", 0)
        title = step.get("title") or step.get("label") or f"Step {idx}"
        description = step.get("description") or step.get("label") or ""
        screenshot = step.get("screenshot")
        screenshot_path = resolve_screenshot(run_dir, screenshot)
        out = frames_dir / f"{idx:02d}_step.png"
        compose_step_frame(idx, title, description, screenshot_path, out)
        step_pngs.append((idx, out, description or title))

    ffmpeg = locate_ffmpeg()
    out_mp4 = run_dir / "demo.mp4"

    if args.narrate:
        ffmpeg_for_tts = ffmpeg
        voice = args.voice or default_voice_for_engine(args.engine)
        synth = build_synthesizer(args.engine, voice, ffmpeg_for_tts)

        audio_dir = run_dir / "audio_clips"
        if audio_dir.exists():
            shutil.rmtree(audio_dir)
        audio_dir.mkdir(parents=True)
        padded_dir = audio_dir / "padded"
        padded_dir.mkdir(parents=True)

        print(f"narrating with engine={args.engine} voice={voice}…")

        cover_audio = audio_dir / "00_cover.wav"
        synth(args.cover_narration, cover_audio)
        cover_dur = max(wav_duration(cover_audio) + 0.5, args.cover_seconds)

        step_audio_specs: list[tuple[Path, float]] = []  # (audio_path, frame_dur)
        for idx, _, narration_text in step_pngs:
            out_wav = audio_dir / f"{idx:02d}_step.wav"
            synth(narration_text, out_wav)
            dur = max(wav_duration(out_wav) + 0.5, args.step_seconds)
            step_audio_specs.append((out_wav, dur))

        # Pad audio clips so each one's duration matches the frame's duration
        # exactly. Concat demuxer then plays them back-to-back, perfectly
        # aligned with the corresponding video frames.
        cover_padded = padded_dir / "00_cover.wav"
        pad_audio(cover_audio, cover_dur, cover_padded, ffmpeg)
        padded_step_audios: list[Path] = []
        for (audio_path, frame_dur), (idx, _, _) in zip(step_audio_specs, step_pngs):
            padded = padded_dir / f"{idx:02d}_step.wav"
            pad_audio(audio_path, frame_dur, padded, ffmpeg)
            padded_step_audios.append(padded)

        frame_durations = [cover_dur] + [d for _, d in step_audio_specs]
        video_concat = frames_dir / "concat.txt"
        write_concat(
            video_concat,
            [(cover_path, cover_dur), *((png, dur) for (_, png, _), dur in zip(step_pngs, [d for _, d in step_audio_specs]))],
        )
        audio_concat = audio_dir / "concat.txt"
        write_simple_concat(audio_concat, [cover_padded, *padded_step_audios])

        total = sum(frame_durations)
        print(f"encoding {len(step_pngs) + 1} frames + narration ({total:.1f}s) with ffmpeg: {ffmpeg}")

        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0", "-i", str(video_concat),
            "-f", "concat", "-safe", "0", "-i", str(audio_concat),
            "-map", "0:v", "-map", "1:a",
            "-vf", f"fps={args.fps},format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-shortest", "-movflags", "+faststart",
            str(out_mp4),
        ]
    else:
        video_concat = frames_dir / "concat.txt"
        write_concat(
            video_concat,
            [(cover_path, args.cover_seconds), *((png, args.step_seconds) for _, png, _ in step_pngs)],
        )
        print(f"encoding {len(step_pngs) + 1} frames with ffmpeg: {ffmpeg}")

        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0", "-i", str(video_concat),
            "-vf", f"fps={args.fps},format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
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


def write_simple_concat(path: Path, files: list[Path]) -> None:
    """Concat list for files whose duration is encoded in the file itself (e.g. WAV)."""
    lines = [f"file '{f.as_posix()}'" for f in files]
    path.write_text("\n".join(lines) + "\n")


def default_voice_for_engine(engine: str) -> str:
    if engine == "edge":
        return "en-US-AriaNeural"
    return "Samantha"


def build_synthesizer(engine: str, voice: str, ffmpeg: str):
    """Return a callable: (text, out_wav_path) -> None.

    The returned function writes a 22kHz mono LE-int16 WAV that Python's
    `wave` module can read for duration probing."""
    if engine == "say":
        ensure_say_available()
        def _say(text: str, out_path: Path) -> None:
            text = text.strip() or "(no narration)"
            cmd = [
                "say",
                "-v", voice,
                "--file-format=WAVE",
                "--data-format=LEI16@22050",
                "-o", str(out_path),
                text,
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                sys.stderr.write(proc.stderr)
                sys.exit(f"`say` failed (exit {proc.returncode}) for text: {text[:80]!r}")
        return _say

    if engine == "edge":
        ensure_edge_tts_available()
        def _edge(text: str, out_path: Path) -> None:
            text = text.strip() or "(no narration)"
            mp3_path = out_path.with_suffix(".mp3")
            cmd = [
                sys.executable, "-m", "edge_tts",
                "--voice", voice,
                "--text", text,
                "--write-media", str(mp3_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                sys.stderr.write(proc.stderr)
                sys.exit(f"edge-tts failed (exit {proc.returncode}) for text: {text[:80]!r}")
            # Convert MP3 → 22kHz mono PCM WAV so duration probing + concat
            # behaves identically to the `say` path.
            conv = subprocess.run(
                [
                    ffmpeg, "-y",
                    "-i", str(mp3_path),
                    "-ac", "1", "-ar", "22050",
                    "-c:a", "pcm_s16le",
                    str(out_path),
                ],
                capture_output=True, text=True,
            )
            mp3_path.unlink(missing_ok=True)
            if conv.returncode != 0:
                sys.stderr.write(conv.stderr)
                sys.exit("ffmpeg conversion failed converting edge-tts mp3 to wav")
        return _edge

    sys.exit(f"unknown TTS engine: {engine}")


def ensure_say_available() -> None:
    if shutil.which("say") is None:
        sys.exit(
            "error: --engine say requires macOS `say`, which was not found.\n"
            "       Try --engine edge instead (cross-platform neural TTS)."
        )


def ensure_edge_tts_available() -> None:
    try:
        import edge_tts  # noqa: F401
    except ModuleNotFoundError:
        sys.exit(
            "error: edge-tts not installed.\n"
            "       run:  pip install -r output/requirements.txt"
        )


def wav_duration(path: Path) -> float:
    import wave
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def pad_audio(input_wav: Path, target_seconds: float, output_wav: Path, ffmpeg: str) -> None:
    """Pad a WAV with trailing silence so total duration is target_seconds."""
    cmd = [
        ffmpeg, "-y",
        "-i", str(input_wav),
        "-af", f"apad=whole_dur={target_seconds:.3f}",
        "-c:a", "pcm_s16le",
        str(output_wav),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"audio pad failed for {input_wav.name}")


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

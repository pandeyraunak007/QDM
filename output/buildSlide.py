#!/usr/bin/env python3
"""Build a single narrated 1920x1080 slide MP4.

Usage:
    python3 output/buildSlide.py \
        --title "Quest Data Modeler — Full Walkthrough" \
        --subtitle "Build, Generate, Edit" \
        --narration "In this walkthrough we'll cover..." \
        --out output/master_intro.mp4 \
        [--engine edge --voice en-US-AriaNeural]

Used to bookend stitched multi-section demos.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

# Reuse the slide composer + synth from videoGenerator
sys.path.insert(0, str(Path(__file__).parent))
from videoGenerator import (  # type: ignore
    compose_cover, compose_outro,
    build_synthesizer, default_voice_for_engine,
    locate_ffmpeg, wav_duration, pad_audio,
)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--title", default="Quest Data Modeler")
    p.add_argument("--subtitle", default="Walkthrough")
    p.add_argument("--narration", required=True)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--style", choices=["cover", "outro"], default="cover")
    p.add_argument("--min-seconds", type=float, default=3.0)
    p.add_argument("--engine", choices=["say", "edge"], default="edge")
    p.add_argument("--voice", default=None)
    p.add_argument("--fps", type=int, default=30)
    args = p.parse_args()

    out = args.out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    work = out.parent / f".{out.stem}_work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    slide = work / "slide.png"
    if args.style == "outro":
        compose_outro(slide)
    else:
        compose_cover(args.title, args.subtitle, 0, slide)

    ffmpeg = locate_ffmpeg()
    voice = args.voice or default_voice_for_engine(args.engine)
    synth = build_synthesizer(args.engine, voice, ffmpeg)

    raw_wav = work / "raw.wav"
    synth(args.narration, raw_wav)
    dur = max(wav_duration(raw_wav) + 0.5, args.min_seconds)

    padded = work / "padded.wav"
    pad_audio(raw_wav, dur, padded, ffmpeg)

    print(f"encoding {dur:.1f}s slide → {out}")
    cmd = [
        ffmpeg, "-y",
        "-loop", "1", "-i", str(slide),
        "-i", str(padded),
        "-vf", f"fps={args.fps},format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-shortest", "-movflags", "+faststart",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"ffmpeg failed (exit {proc.returncode})")
    shutil.rmtree(work)
    print(out)


if __name__ == "__main__":
    main()

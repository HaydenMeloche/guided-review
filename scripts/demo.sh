#!/usr/bin/env bash
# Records the demo of a gr tutor tour from this checkout:
#   docs/images/demo.gif   for the README (GitHub shows a GIF anywhere)
#   docs/images/demo.webp  for the website (full color and smaller than the GIF)
# The keystrokes are in scripts/demo.tape. Needs vhs, ffmpeg, and img2webp: brew install vhs ffmpeg webp
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in vhs ffmpeg img2webp; do
  command -v "$tool" >/dev/null || { echo "demo: $tool not found; brew install vhs ffmpeg webp" >&2; exit 1; }
done

mkdir -p .scratch
frames=$(mktemp -d)
trap 'rm -rf "$frames" .scratch/demo.mp4' EXIT

vhs --quiet scripts/demo.tape

# 15 frames a second is smooth enough for typing and keeps the WebP small.
ffmpeg -v error -i .scratch/demo.mp4 -vf fps=15 "$frames/%04d.png"
img2webp -loop 0 -lossy -q 75 -m 4 -d 67 "$frames"/*.png -o docs/images/demo.webp >/dev/null

ls -lh docs/images/demo.gif docs/images/demo.webp | awk '{print $5, $NF}'

#!/usr/bin/env bash
# Regenerates assets/bgm.m4a from scratch.
#
# The bed is committed as a binary, and a committed binary whose origin is not
# reproducible cannot be reviewed — the design doc's Non-Goals forbid bundling
# media without a clear licence, and "trust me, it is original" is not one.
# This script is the licence: every sample below comes from ffmpeg's own signal
# generators, so the output is a derivative of nothing.
#
#   ./assets/generate-bgm.sh
#
# Deterministic: same ffmpeg build, same bytes.
set -euo pipefail
cd "$(dirname "$0")"

# Three sine partials a fifth and an octave apart (A2 / E3 / A3), each with a
# slow tremolo at a different rate so the beat pattern does not repeat inside
# the 30s window. Kept well below the -16 dB the composition mixes it at, so it
# sits under the captions rather than competing with them.
ffmpeg -y -v error \
  -f lavfi -t 30 -i "sine=frequency=110:sample_rate=48000" \
  -f lavfi -t 30 -i "sine=frequency=164.81:sample_rate=48000" \
  -f lavfi -t 30 -i "sine=frequency=220:sample_rate=48000" \
  -filter_complex "\
    [0:a]tremolo=f=0.20:d=0.55,volume=0.50[a0]; \
    [1:a]tremolo=f=0.27:d=0.50,volume=0.30[a1]; \
    [2:a]tremolo=f=0.33:d=0.45,volume=0.18[a2]; \
    [a0][a1][a2]amix=inputs=3:normalize=0,\
      lowpass=f=1200,\
      afade=t=in:st=0:d=2,afade=t=out:st=27:d=3,\
      volume=0.9,\
      pan=stereo|c0=c0|c1=c0[out]" \
  -map "[out]" -c:a aac -b:a 96k -ar 48000 -ac 2 bgm.m4a

ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,channels,sample_rate \
  -of default=noprint_wrappers=1 bgm.m4a

# FrontAgent Douyin Promo HyperFrames Project

Source for the 30-second vertical FrontAgent Douyin promo video.

## Layout

- `index.html` — composition markup plus the timeline registration HyperFrames
  reads (`window.__timelines`). The lint rule that checks for it parses this file
  as text, so the timeline has to stay inline.
- `styles.css` — all presentation. Extracted so the composition file stays
  scannable; `hyperframes lint` still warns that 472 lines is large and suggests
  splitting the six scenes into `compositions/*.html` mounted with
  `data-composition-src`. That is the right end state and is tracked as
  follow-up: sub-compositions are standalone documents, so it means splitting
  the shared token layer and the cross-scene timeline too, which is a bigger
  change than the one this project is here to land.

## Requirements

- Node.js 22+
- FFmpeg
- Network access for `npx hyperframes` on first run

## Commands

```bash
npx hyperframes lint
npx hyperframes preview
npx hyperframes render --output dist/frontagent-douyin-promo.mp4
```

## Audio

`assets/bgm.m4a` is generated, not sourced. `assets/generate-bgm.sh` builds it from
ffmpeg's own signal generators — three sine partials (A2 / E3 / A3), each with a
slow tremolo at a different rate, low-passed and faded — so it is a derivative of
nothing and its provenance is checkable rather than asserted:

```bash
./assets/generate-bgm.sh
```

Regenerating it is deterministic for a given ffmpeg build. `assets/bgm-captions.vtt`
carries the required media caption cue.

The composition mixes it at `data-volume="0.16"` so it sits under the captions.

Run commands from this directory:

```bash
cd marketing/hyperframes/frontagent-douyin-promo
```

The rendered MP4 is a local artifact under `dist/`. Repository `.gitignore` ignores `dist/`, so the MP4 is not committed by default.

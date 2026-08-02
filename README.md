# AutoEdit Studio

AutoEdit Studio is a review-first desktop editor for English headtalk videos. It creates a local proxy and transcript, asks the signed-in Codex CLI to propose a concise bilingual edit, lets the user review every cut and subtitle, and renders a vertical MP4 with FFmpeg.

## Requirements

- Node.js 20.11 or newer
- FFmpeg and FFprobe on `PATH`, or configured in the app
- Codex CLI installed and signed in
- Satoshi Bold installed or selected as a local font file

## Run from source

```powershell
npm ci
npm run desktop
```

Use `npm run check` for type checks, tests, and production builds. Product goals and architecture live in `docs/`.

## Build installers

```powershell
npm run package:win
```

On macOS, run `npm run package:mac`. Artifacts are written to `release/`. They are intentionally unsigned in the personal-use MVP.

## Privacy and review model

The source file is referenced in place and never copied into the project. Whisper runs locally. Codex receives timestamped transcript text, media metadata, and five proxy JPEG evidence frames—not original video or audio. Every agent result is staged as a Proposal; rendering is disabled until an accepted plan is explicitly approved as Final.

Project documents and resumable checkpoints live under Electron's per-user `userData/projects` directory. The renderer receives only sanitized metadata and an opaque `media://` proxy URL.

Supported source codecs preview immediately after Import through an opaque media route. Use **9:16 crop** to inspect final framing or **Fit source** to inspect the full recorded frame. HEVC or another codec unsupported by Electron shows a recovery action that creates the standard H.264 SDR proxy. Runtime diagnostics are recorded in `userData/logs/app.log`.

## Fonts

Be Vietnam Pro SemiBold and its OFL license are bundled in `assets/fonts`. Satoshi is not redistributed: select a legally obtained Satoshi Bold `.ttf` or `.otf` in the system check panel. Render stops if it is missing.

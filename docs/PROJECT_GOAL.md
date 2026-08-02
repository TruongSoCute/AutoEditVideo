# Project goal

## Mission

AutoEdit Studio turns one local English headtalk recording into a concise bilingual Instagram Reel through a transparent, review-first desktop workflow.

## MVP scope

- One local MOV, MP4, M4V, or MKV source per project.
- Local FFmpeg media inspection, HDR-to-SDR proxy generation, frame extraction, audio cleanup, and final rendering.
- Local Whisper transcription with cached model files.
- Structured Codex CLI editorial, subtitle, and review proposals.
- Explicit Proposal acceptance and Final approval before render.
- Windows and macOS source builds and unsigned personal-use packages.

## Success criteria

1. The user can complete Import, Analyze, Review, Approve, and Render inside the app.
2. Final output is H.264/AAC, 1080x1920, 30 fps, 60-120 seconds, with English and Vietnamese subtitles.
3. Source timestamps remain chronological, in bounds, non-overlapping, and auditable.
4. Moving or changing the source invalidates incompatible checkpoints and requires relinking or reanalysis.
5. Raw video and audio are never sent to Codex; only transcript, metadata, and selected evidence frames are attached.

## Out of scope

URL import, batch processing, B-roll, background music, multi-track editing, cloud sync, accounts, code signing, notarization, and store publishing.


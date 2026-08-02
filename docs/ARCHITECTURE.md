# Architecture

## Layers

```text
React renderer -> typed preload IPC -> Electron main
                                      |- project store + checkpoints
                                      |- FFmpeg/FFprobe + proxy + ASR
                                      |- Codex CLI structured agent
                                      `- Review/Final + atomic render
```

- `src/renderer/`: sandboxed React interface. It receives sanitized project data and opaque media URLs.
- `src/main/`: Electron lifecycle, dialogs, protocol registration, IPC validation, job cancellation, and progress delivery.
- `src/core/`: deterministic media, project, schema, Codex, analysis, review, and render services.
- `src/shared/`: serializable contracts shared across the IPC boundary.

## Data flow

1. Import probes and fingerprints the source without copying it.
2. Proxy generation normalizes orientation and HDR color for reliable preview.
3. Local Whisper creates timestamped English transcript cues.
4. Evidence frames plus transcript are sent to sandboxed `codex exec` calls constrained by JSON Schema.
5. Local validators create a pending Proposal. The user accepts it into Review and approves an immutable Final snapshot.
6. FFmpeg renders only that Final snapshot to a partial file, verifies it with FFprobe, then renames it atomically.

## Security invariants

- Renderer uses `contextIsolation: true`, `nodeIntegration: false`, sandbox, and a strict CSP.
- Raw paths remain in Electron main; preview media is exposed through an opaque custom-protocol token.
- Codex runs in an empty work directory with a read-only sandbox and tool-capable features disabled.
- On Windows, the npm Codex entry point runs through Electron's bundled Node mode instead of relying on the GUI process `PATH`. Model-catalog requests are single-flight and briefly cached so concurrent dependency and picker refreshes share one authenticated app-server session.
- Prompts and raw model output never enter renderer progress logs.
- Output never overwrites source media.

## Project lifecycle

Projects are stored atomically in Electron `userData/projects/<uuid>/project.json`; source media remains in place. The fingerprint hashes file size plus the first and last MiB, so a moved or recopied source can be relinked even when its filesystem modification time changes. Proxy, ASR, editorial and subtitle stages are independently resumable. Agent checkpoints include source fingerprint, selected model, reasoning level and prompt version.

`ProjectDocument` is main-process-only. `PublicProject` strips source/cache/export, FFmpeg and font paths before crossing IPC. All project identifiers are UUID-validated before they become filesystem components.

Preview media crosses the renderer boundary only through the opaque `media://project/<uuid>/source|proxy` protocol. The source route makes supported codecs playable immediately after Import and implements HTTP `206 Partial Content`, `Accept-Ranges`, `Content-Range`, bounded byte streams and `416` handling for seeking. Once analysis creates an autorotated SDR proxy, the renderer switches to that route. Playback failures are recoverable in the UI and recommend proxy generation.

Main-process and bounded renderer diagnostics are written as rotating JSON Lines to `userData/logs/app.log`. Preview logs contain project id, route kind, basename, Range request and media element state, but never expose raw filesystem paths to the renderer.

Analysis progress streams live FFmpeg proxy timestamps and bounded Whisper/Codex activity through typed progress events. The renderer keeps a per-run activity timeline, weighted overall progress, elapsed time and explicit running/stopping/cancelled/complete states. Stop aborts the active subprocess without resetting its last percentage; completed stage checkpoints remain resumable. Proxy and PCM generation write to temporary files and rename atomically, so cancellation cannot promote incomplete media into the cache.

Whisper runs in Electron's Node main process, where `AudioContext` is unavailable. The ASR boundary therefore validates the FFmpeg-generated mono 16 kHz PCM 16-bit WAV, decodes it to normalized `Float32Array` samples, and passes the waveform directly to Transformers.js instead of passing a filesystem path.

Whisper timestamps are normalized against the probed source duration before validation: tail padding is clamped, small overlaps are trimmed, and empty out-of-range cues are discarded. Cached transcripts pass through the same normalization on resume. All external tools are launched through one hidden, pipe-only subprocess boundary with the Windows shell disabled so FFmpeg, FFprobe and Codex do not flash console windows.

## Render contract

Approval requires a 60–120 second accepted plan. Render verifies source fingerprint and font availability, requires at least 1 GB free space, writes a sibling `.partial.mp4`, validates H.264/AAC, 1080×1920 and duration with FFprobe, then atomically renames. Cancellation and failure remove the partial file.

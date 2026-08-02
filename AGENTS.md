# Agent instructions

## Product invariants

- `docs/PROJECT_GOAL.md` and `docs/ARCHITECTURE.md` are the source of truth for product scope and system boundaries.
- Update the relevant document whenever behavior, data flow, or module ownership changes.
- Repository Markdown is documentation only. Runtime AI context must come from TypeScript policy constants, user-selected project data, and generated evidence.
- A Codex result is always a Proposal. Only locally validated, explicitly accepted Review state may become Final.
- Render reads only a Final snapshot whose source fingerprint still matches the current media.

## Verification

Run `npm run check` before committing. Keep Electron renderer sandboxed with context isolation and expose only typed IPC methods through preload.


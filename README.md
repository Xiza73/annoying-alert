# Waqyay

A Windows desktop reminder app that won't let you ignore it.

## Download

[**Waqyay v0.1.0 — Windows Installer (MSI)**](https://github.com/Xiza73/annoying-alert/releases/latest)

Requires Windows 10/11 x64.

## What is this?

Waqyay (Quechua: "to call") is a rewrite of a Python/Tkinter intrusive-reminder app, rebuilt as a
native Windows desktop app using Tauri v2 and React 19. It uses escalating overlay levels (1–5)
that go from a small toast notification all the way to a fullscreen takeover with a countdown. Built
for people who need aggressive reminders because they'll dismiss anything less.

## Features

### Reminders

- Create, edit, and delete reminders with title, description, category, and color
- **One-shot** reminders that fire once at a scheduled time
- **Recurring** reminders on a fixed interval or a cron expression
- **Pomodoro** reminders with configurable work and break phases
- Reminders ordered by urgency (active first, then nearest trigger time)
- Delete confirmation dialogs for single and bulk delete actions

### Intrusiveness Levels

| Level | Behavior |
|-------|----------|
| L1 | Small toast notification |
| L2–L4 | Progressively larger, more prominent overlays |
| L5 | Fullscreen takeover — covers everything until dismissed |

### Audio

- Upload custom sounds (WAV, MP3, OGG) with human-readable labels
- Synthetic beep patterns as default sounds, intensity scaled per level
- Audio loops until the reminder is dismissed
- Global volume slider in settings with a live preview button

### Scheduling

- **Snooze** with a configurable default duration
- **Quiet hours** with configurable start and end time
- Pause and resume recurring reminders (next trigger rebased on resume)

### System Integration

- System tray icon with quick access to settings and quit
- Close-to-tray on the X button — the app keeps running in the background
- Start minimized option for a silent background launch
- Autostart on Windows login
- Single instance enforcement: a second launch focuses the existing window

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 (with React Compiler) + TypeScript + Tailwind CSS 4 + shadcn/ui |
| Backend | Rust + Tauri v2 |
| Database | SQLite via rusqlite (statically bundled) |
| Forms | react-hook-form + Zod 4 |
| Bundler | Vite + WiX (MSI) |

## Development

```bash
# Prerequisites: Node.js 20+, pnpm, Rust stable toolchain

pnpm install
pnpm tauri dev
```

Build the MSI installer:

```bash
pnpm tauri build
```

Run Rust unit tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Frontend checks:

```bash
pnpm typecheck && pnpm lint
```

## License

MIT

# Changelog

All notable changes to Waqyay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-12

First production-ready release. Waqyay is a Windows desktop reminder app
built with Tauri v2 + React 19 that uses intrusive, escalating overlays
(levels 1-5) to make sure you actually pay attention.

### Added

- **Reminders CRUD** with title, description, category, color, and 5 intrusiveness levels
- **Reminder types**: one-shot, recurring (interval + cron), and Pomodoro (work/break phases)
- **Intrusive overlays** that scale from a small toast (L1) to fullscreen takeover (L5)
- **Custom audio**: upload WAV/MP3/OGG files with content-addressed storage and human-readable labels
- **Synthetic beep patterns** as default sounds, intensity scaled per level
- **Audio loop until dismiss**: both custom files and synth beeps loop for the duration of the alarm
- **Global alarm volume** slider in settings with live preview button
- **Snooze** with configurable default duration
- **Quiet hours** with start/end time configuration
- **System tray** icon with quick access to settings and quit
- **Close-to-tray** on X button instead of exiting
- **Start minimized** option for silent background launch
- **Autostart** on Windows login via Tauri autostart plugin
- **Single instance** enforcement: second launch focuses the existing window
- **Delete confirmations** on single reminder and "delete all" actions
- **Settings sheet** with save-to-toast feedback
- **MSI installer** with WiX-based bundling
- **SQLite persistence** with automatic migrations (v1 base schema, v2 sound_files metadata)
- **Reminder ordering** by active status and next trigger time (most urgent first)

### Fixed

- Pause/resume on recurring reminders no longer fires immediately (next_trigger rebased on resume)
- Stale `snooze_until` no longer blocks reminders after edit or fire
- Level 5 fullscreen overlay dismiss now works reliably on Windows (WebView2 fullscreen workaround)
- Stale `onCloseRequested` listeners no longer accumulate on L5 overlays
- Custom sounds now persist after their associated reminders are deleted
- Paused reminders show "Pausada" instead of stale relative time

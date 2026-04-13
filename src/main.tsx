// Entry point — never exports components, so fast-refresh rule does not apply.
/* eslint-disable react-refresh/only-export-components */
import "./index.css";

import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";

import App from "@/app/App";

/**
 * Single Vite entry, two possible React trees.
 *
 * The Rust side spawns a second Tauri webview window for intrusive
 * reminder overlays. That window loads the exact same bundle as the main
 * app but with `?mode=overlay&id=<reminder_id>` in the URL. We inspect
 * those params here and mount the right component:
 *
 *   - default → `<App />`: the main Waqyay window (list, settings, etc.)
 *   - `?mode=overlay` → `<Overlay />`: the full-screen intrusive popup
 *
 * No React Router, no separate HTML entry. One build, one bundle,
 * branching decided at boot time.
 *
 * The overlay module is code-split via React.lazy so it does not inflate
 * the main app chunk — it is fetched on demand only when the overlay
 * window actually boots.
 */

// Dynamic import keeps the overlay + sound module out of the main chunk.
// React.lazy requires a default export, so we re-shape the named export
// via the promise chain rather than touching Overlay.tsx.
const Overlay = React.lazy(() =>
  import("@/features/reminders/overlay/Overlay").then((m) => ({
    default: m.Overlay,
  })),
);

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode");

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found in index.html");
}
const root = ReactDOM.createRoot(container);

if (mode === "overlay") {
  const idParam = params.get("id");
  const reminderId = idParam ? Number(idParam) : NaN;

  // Intrusiveness level drives which overlay variant renders. Rust
  // always sets this, but we parse defensively and clamp into 1..5.
  const levelParam = params.get("level");
  const parsedLevel = levelParam ? Number(levelParam) : 3;
  const level = Number.isFinite(parsedLevel)
    ? (Math.min(5, Math.max(1, Math.round(parsedLevel))) as 1 | 2 | 3 | 4 | 5)
    : 3;

  if (!Number.isFinite(reminderId)) {
    // Shouldn't happen — Rust always includes a valid id — but if it
    // does, render a minimal error state instead of a blank screen.
    root.render(
      <div style={{ padding: 24, fontFamily: "monospace", color: "#fff" }}>
        overlay: invalid or missing reminder id
      </div>,
    );
  } else {
    root.render(
      <React.StrictMode>
        {/* Suspense fallback is null — the overlay chunk loads in <100ms
            locally and a blank black screen is preferable to a flash of
            any placeholder UI in a fullscreen takeover window. */}
        <Suspense fallback={null}>
          <Overlay reminderId={reminderId} level={level} />
        </Suspense>
      </React.StrictMode>,
    );
  }
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

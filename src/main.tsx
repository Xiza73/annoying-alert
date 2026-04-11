import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";

import App from "@/app/App";
import { Overlay } from "@/features/reminders/overlay/Overlay";

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
 */
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
        <Overlay reminderId={reminderId} level={level} />
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

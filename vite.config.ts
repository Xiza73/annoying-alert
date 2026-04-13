import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        /**
         * Split heavy vendor libs into separate chunks so the main entry
         * chunk stays well under the 500 kB warning limit.
         *
         * Groups:
         *  - react-vendor  : React + React-DOM (runtime, rarely changes)
         *  - radix         : all Radix UI primitives (large but tree-shaken at use-site)
         *  - form          : react-hook-form + zod (form/validation stack)
         *  - tauri         : @tauri-apps/* (IPC layer)
         */
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/radix-ui/") || id.includes("node_modules/@radix-ui/")) {
            return "radix";
          }
          if (id.includes("node_modules/react-hook-form/") || id.includes("node_modules/zod/") || id.includes("node_modules/@hookform/")) {
            return "form";
          }
          if (id.includes("node_modules/@tauri-apps/")) {
            return "tauri";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";

/**
 * Landing temporal de verificacion para Fase 1.
 * Confirma que Tailwind 4, la paleta, el alias @ y el IPC Tauri
 * estan todos cableados. Esta pantalla sera reemplazada en Fase 4
 * por la UI real de Waqyay.
 */
function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-8 bg-background p-8 text-text-primary">
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={cn(
            "rounded-xl border border-border bg-surface px-5 py-2",
            "font-mono text-xs tracking-widest uppercase text-text-secondary",
          )}
        >
          waqyay · bootstrap check
        </div>
        <h1 className="text-5xl font-bold tracking-tight">
          <span className="text-text-primary">The reminder that </span>
          <span className="text-accent">calls your name.</span>
        </h1>
        <p className="max-w-md text-text-secondary">
          Quechua for &ldquo;to call&rdquo; or &ldquo;to summon&rdquo;. Waqyay
          interrupts, so you don&apos;t forget what matters.
        </p>
      </div>

      <form
        className="flex w-full max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          className={cn(
            "flex-1 rounded-lg border border-border bg-surface px-4 py-2.5",
            "text-text-primary placeholder:text-text-muted",
            "outline-none focus:border-accent",
          )}
          placeholder="Your name..."
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <button
          type="submit"
          className={cn(
            "rounded-lg bg-accent px-5 py-2.5 font-medium text-white",
            "transition-colors hover:bg-accent-hover",
          )}
        >
          Call me
        </button>
      </form>

      {greetMsg && (
        <p className="rounded-lg border border-border bg-surface px-4 py-2 text-sm text-text-secondary">
          {greetMsg}
        </p>
      )}
    </main>
  );
}

export default App;

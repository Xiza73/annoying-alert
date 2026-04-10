import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * Landing temporal de verificacion para Fase 1.
 * Confirma que Tailwind 4, la paleta shadcn+Raycast, el alias @
 * y el IPC Tauri estan todos cableados. Esta pantalla sera
 * reemplazada en Fase 4 por la UI real de Waqyay.
 */
function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-8 bg-background p-8 text-foreground">
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={cn(
            "rounded-xl border border-border bg-card px-5 py-2",
            "font-mono text-xs tracking-widest uppercase text-muted-foreground",
          )}
        >
          waqyay · bootstrap check
        </div>
        <h1 className="text-5xl font-bold tracking-tight font-heading">
          <span className="text-foreground">The reminder that </span>
          <span className="text-primary">calls your name.</span>
        </h1>
        <p className="max-w-md text-muted-foreground">
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
            "flex-1 rounded-lg border border-border bg-card px-4 py-2.5",
            "text-foreground placeholder:text-muted-foreground",
            "outline-none focus:border-primary focus:ring-2 focus:ring-ring/30",
          )}
          placeholder="Your name..."
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Button type="submit" size="lg">
          Call me
        </Button>
      </form>

      {greetMsg && (
        <p className="rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
          {greetMsg}
        </p>
      )}
    </main>
  );
}

export default App;

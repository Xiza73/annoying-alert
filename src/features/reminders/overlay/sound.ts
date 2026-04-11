/**
 * Overlay sound playback.
 *
 * Two paths:
 *
 * 1. **Custom**: if the reminder's `sound_file` is a real filename
 *    (not `"default"` or empty), we fetch it as a data URL from Rust
 *    and play it through an `<audio>` element. Supports mp3/wav/ogg/
 *    flac/m4a — whatever the OS webview decodes.
 *
 * 2. **Synthetic**: otherwise we synthesize a short beep pattern via
 *    the Web Audio API, scaled by intrusiveness level. No assets to
 *    ship, no permissions to configure, zero bundle overhead.
 *
 * The synthetic route was picked specifically so the MSI installer
 * stays tiny and the app works immediately after install — no user
 * ceremony to pick a sound before the first reminder fires.
 */

import { getSoundDataUrl } from "@/features/reminders/api";

/** Exposed by `useOverlaySound` — play once, then stop on unmount. */
export interface OverlaySoundController {
  /** Fire-and-forget playback. Safe to call multiple times. */
  play: () => Promise<void>;
  /** Stop any in-progress sound (used on dismiss / snooze). */
  stop: () => void;
}

/**
 * Build an `OverlaySoundController` for a given (soundFile, level).
 * Does NOT start playback automatically — the caller decides when to
 * trigger it (typically in a `useEffect` after the reminder loads).
 */
export function createOverlaySound(
  soundFile: string,
  level: number,
): OverlaySoundController {
  // Normalize empty string / legacy "default" to synthetic mode.
  const useCustom = soundFile.trim().length > 0 && soundFile !== "default";

  let audioEl: HTMLAudioElement | null = null;
  let ctx: AudioContext | null = null;

  async function play(): Promise<void> {
    if (useCustom) {
      try {
        const url = await getSoundDataUrl(soundFile);
        audioEl = new Audio(url);
        audioEl.volume = volumeForLevel(level);
        await audioEl.play();
      } catch (err) {
        console.warn("overlay: custom sound failed, falling back", err);
        playSynth(level).catch((synthErr: unknown) => {
          console.warn("overlay: synth fallback also failed", synthErr);
        });
      }
    } else {
      await playSynth(level).catch((err: unknown) => {
        console.warn("overlay: synth playback failed", err);
      });
    }
  }

  function stop(): void {
    audioEl?.pause();
    audioEl = null;
    if (ctx !== null && ctx.state !== "closed") {
      void ctx.close();
    }
    ctx = null;
  }

  async function playSynth(lvl: number): Promise<void> {
    ctx = new AudioContext();
    await playBeepPattern(ctx, lvl);
  }

  return { play, stop };
}

// ─── Synthetic beep patterns ─────────────────────────────────────────────────

/**
 * Scale output volume (0..1) by intrusiveness level. L1/L2 are quiet
 * toasts — we match that with a softer beep; L5 is a full takeover, so
 * we crank it. Users can still adjust their OS master volume.
 */
function volumeForLevel(level: number): number {
  switch (level) {
    case 1:
      return 0.2;
    case 2:
      return 0.3;
    case 3:
      return 0.5;
    case 4:
      return 0.7;
    default:
      return 0.85;
  }
}

/**
 * Synthesize a short beep pattern. Higher levels get more beeps and a
 * rising pitch sweep. The whole thing takes under 2s at every level so
 * it never outlasts the user's reaction time.
 */
async function playBeepPattern(ctx: AudioContext, level: number): Promise<void> {
  const volume = volumeForLevel(level);
  switch (level) {
    case 1:
      // Soft single blip.
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      break;
    case 2:
      // Two quick blips.
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      await silence(80);
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      break;
    case 3:
      // Classic "ding dong" — two tones.
      await beep(ctx, { freq: 880, duration: 0.18, volume });
      await silence(60);
      await beep(ctx, { freq: 660, duration: 0.22, volume });
      break;
    case 4:
      // Three rising tones.
      await beep(ctx, { freq: 660, duration: 0.15, volume });
      await silence(40);
      await beep(ctx, { freq: 880, duration: 0.15, volume });
      await silence(40);
      await beep(ctx, { freq: 1100, duration: 0.22, volume });
      break;
    default:
      // L5: attention pattern — alternating high/low x3.
      for (let i = 0; i < 3; i += 1) {
        await beep(ctx, { freq: 1100, duration: 0.12, volume });
        await silence(40);
        await beep(ctx, { freq: 700, duration: 0.12, volume });
        await silence(60);
      }
      break;
  }
}

interface BeepOpts {
  freq: number;
  duration: number;
  volume: number;
}

/**
 * Play a single tone at `freq` Hz for `duration` seconds. Uses a short
 * attack/release envelope (3ms each) to avoid clicks on start/stop —
 * raw square waves sound nasty without it.
 */
function beep(ctx: AudioContext, opts: BeepOpts): Promise<void> {
  return new Promise((resolve) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = opts.freq;
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    const attack = 0.003;
    const release = 0.003;
    // Ramp up → sustain → ramp down. `linearRampToValueAtTime` is the
    // cheapest way to avoid pops.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(opts.volume, now + attack);
    gain.gain.setValueAtTime(opts.volume, now + opts.duration - release);
    gain.gain.linearRampToValueAtTime(0, now + opts.duration);

    osc.start(now);
    osc.stop(now + opts.duration);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      resolve();
    };
  });
}

/** Plain delay helper because Web Audio's clock and setTimeout don't mix. */
function silence(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

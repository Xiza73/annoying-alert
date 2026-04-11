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
 *
 * # Loop semantics
 *
 * Waqyay is supposed to be *impossible to ignore*. Short custom
 * clips (1-2s alarms, single beeps) would finish and leave a silent
 * overlay staring at the user. That's the opposite of intrusive. So
 * the default on fire is **loop until dismissed** — the audio keeps
 * playing until `stop()` is called from the overlay's unmount.
 *
 * The synthetic beep pattern also loops, with a short gap between
 * cycles so the user can still think between bursts.
 */

import { getSoundDataUrl } from "@/features/reminders/api";

/** Exposed by `useOverlaySound` — play once, then stop on unmount. */
export interface OverlaySoundController {
  /** Fire-and-forget playback. Safe to call multiple times. */
  play: () => Promise<void>;
  /** Stop any in-progress sound (used on dismiss / snooze). */
  stop: () => void;
}

export interface OverlaySoundOptions {
  /** Global master multiplier applied on top of the level curve (0..1). */
  masterVolume?: number;
  /** Loop the sound until `stop()` is called. Default: true. */
  loop?: boolean;
}

/**
 * Build an `OverlaySoundController` for a given (soundFile, level).
 * Does NOT start playback automatically — the caller decides when to
 * trigger it (typically in a `useEffect` after the reminder loads).
 */
export function createOverlaySound(
  soundFile: string,
  level: number,
  options: OverlaySoundOptions = {},
): OverlaySoundController {
  const masterVolume = clamp01(options.masterVolume ?? 1);
  const loop = options.loop ?? true;

  // Normalize empty string / legacy "default" to synthetic mode.
  const useCustom = soundFile.trim().length > 0 && soundFile !== "default";

  let audioEl: HTMLAudioElement | null = null;
  let ctx: AudioContext | null = null;
  // Stopped flag doubles as the loop-exit signal for the synth path
  // and as a guard so `play()` is idempotent.
  let stopped = false;

  async function play(): Promise<void> {
    if (useCustom) {
      try {
        const url = await getSoundDataUrl(soundFile);
        audioEl = new Audio(url);
        audioEl.volume = clamp01(volumeForLevel(level) * masterVolume);
        audioEl.loop = loop;
        await audioEl.play();
      } catch (err) {
        console.warn("overlay: custom sound failed, falling back", err);
        synthLoop().catch((synthErr: unknown) => {
          console.warn("overlay: synth fallback also failed", synthErr);
        });
      }
    } else {
      synthLoop().catch((err: unknown) => {
        console.warn("overlay: synth playback failed", err);
      });
    }
  }

  function stop(): void {
    stopped = true;
    audioEl?.pause();
    audioEl = null;
    if (ctx !== null && ctx.state !== "closed") {
      void ctx.close();
    }
    ctx = null;
  }

  /**
   * Loop the synthetic beep pattern until `stopped` flips. We keep a
   * small gap between cycles (600ms for L1/L2, shorter for higher
   * levels) so the pattern doesn't turn into a single continuous
   * noise. Early-return after every step so cancelling is instant.
   */
  async function synthLoop(): Promise<void> {
    ctx = new AudioContext();
    const gap = gapForLevel(level);
    while (!stopped) {
      await playBeepPattern(ctx, level, masterVolume);
      if (stopped || !loop) break;
      await silence(gap);
    }
  }

  return { play, stop };
}

/**
 * One-shot preview helper used by the SettingsSheet volume slider. It
 * plays a single synth pattern at the requested level + volume and
 * resolves when done. No loop, no file I/O, zero coupling to the
 * reminder state — perfect for "Probar".
 */
export async function playPreview(
  level: number,
  masterVolume: number,
): Promise<void> {
  const ctx = new AudioContext();
  try {
    await playBeepPattern(ctx, level, clamp01(masterVolume));
  } finally {
    if (ctx.state !== "closed") {
      void ctx.close();
    }
  }
}

// ─── Synthetic beep patterns ─────────────────────────────────────────────────

/**
 * Scale output volume (0..1) by intrusiveness level. L1/L2 are quiet
 * toasts — we match that with a softer beep; L5 is a full takeover, so
 * we crank it. Users can still adjust their OS master volume, and the
 * global `masterVolume` further multiplies this.
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
 * Silence gap between loop iterations, in milliseconds. Longer at low
 * levels so the user isn't bombarded; shorter at L5 where continuous
 * pressure is the point.
 */
function gapForLevel(level: number): number {
  switch (level) {
    case 1:
      return 2500;
    case 2:
      return 1800;
    case 3:
      return 1200;
    case 4:
      return 800;
    default:
      return 500;
  }
}

/**
 * Synthesize a short beep pattern. Higher levels get more beeps and a
 * rising pitch sweep. The whole thing takes under 2s at every level so
 * it never outlasts the user's reaction time inside a single loop
 * iteration.
 */
async function playBeepPattern(
  ctx: AudioContext,
  level: number,
  masterVolume: number,
): Promise<void> {
  const volume = clamp01(volumeForLevel(level) * masterVolume);
  switch (level) {
    case 1:
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      break;
    case 2:
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      await silence(80);
      await beep(ctx, { freq: 880, duration: 0.12, volume });
      break;
    case 3:
      await beep(ctx, { freq: 880, duration: 0.18, volume });
      await silence(60);
      await beep(ctx, { freq: 660, duration: 0.22, volume });
      break;
    case 4:
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

/** Clamp a float into the closed interval [0, 1]. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

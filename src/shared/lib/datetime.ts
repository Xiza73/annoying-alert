/**
 * Date/time helpers for the Waqyay frontend.
 *
 * # Why we don't use `toISOString()`
 *
 * The Rust backend stores timestamps as `chrono::NaiveDateTime` — no
 * timezone attached — and the scheduler compares them against
 * `Local::now().naive_local()`. The Python ancestor of this app did the
 * same thing (`datetime('now', 'localtime')` as SQL default). The whole
 * project convention is "local naive time everywhere in the DB".
 *
 * JavaScript's `Date.prototype.toISOString()` ALWAYS returns UTC,
 * regardless of the user's timezone. If we slice that to "YYYY-MM-DDTHH:MM:SS"
 * and send it to Rust, a user in Peru (UTC-5) creating a reminder for "right
 * now" will get a timestamp 5 hours in the future — and the scheduler will
 * happily never fire it.
 *
 * Hence this helper: it reads the LOCAL components of a `Date` and formats
 * them manually, sidestepping UTC conversion entirely.
 */

/**
 * Format a `Date` as a naive local ISO-like string: `YYYY-MM-DDTHH:MM:SS`.
 *
 * No timezone suffix. No UTC conversion. The string represents the wall
 * clock time the user sees right now, which is exactly what the Rust
 * `NaiveDateTime` deserializer expects.
 */
export function toNaiveLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Parse a `NaiveDateTime` string (as produced by the Rust backend) back
 * into a JS `Date` by treating the components as local wall-clock time.
 *
 * `new Date("2026-04-10T15:00:00")` technically works in modern engines
 * (it's interpreted as local when no timezone suffix is present) but the
 * behavior is spec-fuzzy enough that we parse it explicitly.
 */
export function fromNaiveLocal(naive: string): Date {
  const match = naive.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
  );
  if (!match) return new Date(NaN);
  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
}

/**
 * Human-friendly relative-time string for reminder cards. Examples:
 *   "ahora", "en 45s", "en 12m", "en 3h 20m", "en 2d 4h",
 *   "hace 30s", "hace 5m", "—"
 *
 * We keep it deliberately short (Raycast-ish) and Spanish-first since
 * this is what the list view renders next to each reminder.
 */
export function formatRelative(
  naive: string | null,
  now: Date = new Date(),
): string {
  if (!naive) return "—";
  const target = fromNaiveLocal(naive);
  if (Number.isNaN(target.getTime())) return "—";

  const diffMs = target.getTime() - now.getTime();
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  const past = diffMs < 0;

  if (absSec < 5) return "ahora";

  let core: string;
  if (absSec < 60) {
    core = `${absSec}s`;
  } else if (absSec < 3600) {
    core = `${Math.round(absSec / 60)}m`;
  } else if (absSec < 86400) {
    const h = Math.floor(absSec / 3600);
    const m = Math.round((absSec % 3600) / 60);
    core = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else {
    const d = Math.floor(absSec / 86400);
    const h = Math.round((absSec % 86400) / 3600);
    core = h > 0 ? `${d}d ${h}h` : `${d}d`;
  }

  return past ? `hace ${core}` : `en ${core}`;
}

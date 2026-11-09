/**
 * New-ticket alert for the kitchen display: which tickets just arrived (pure,
 * tested), a short two-tone chime, and the device-local mute preference.
 */
import type { KitchenTicket } from "./types";

/** Tickets whose order id was not in `known` (null known = first load: none are new). */
export function newTickets(
  known: ReadonlySet<string> | null,
  tickets: KitchenTicket[],
): KitchenTicket[] {
  if (known === null) return [];
  return tickets.filter((t) => !known.has(t.order.id));
}

const MUTE_KEY = "kds.alertMuted";

export function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* not persisted */
  }
}

let ctx: AudioContext | null = null;

/** Call from a user gesture (the mute toggle) so browsers allow later chimes. */
export function primeAudio(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* no audio available */
  }
}

/** A short two-tone chime. Silent (never throws) when audio is unavailable. */
export function playChime(): void {
  try {
    primeAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t0 + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch {
    /* ignore */
  }
}

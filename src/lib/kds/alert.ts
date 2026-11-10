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

/** Whether chimes can play right now (context created and running). */
export function isAudioRunning(): boolean {
  return ctx?.state === "running";
}

/**
 * Create / resume the audio context. Call from a user gesture (browsers keep it
 * suspended until then); resolves true once chimes can play.
 */
export async function primeAudio(): Promise<boolean> {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") await ctx.resume();
    return ctx.state === "running";
  } catch {
    return false;
  }
}

/** A short two-tone chime. Silent (never throws) when audio is unavailable. */
export function playChime(): void {
  try {
    if (!ctx || ctx.state !== "running") return;
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

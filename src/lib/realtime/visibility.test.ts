/**
 * Visibility-aware polling: pauses while the tab is hidden, ticks at once when
 * it is visible again, and backs off on a schedule that reset() restarts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "./visibility";
import { createPollingProvider } from "./polling";

type Listener = () => void;
function fakeDocument() {
  const listeners = new Set<Listener>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    set(state: "visible" | "hidden") {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
  return doc;
}

let doc: ReturnType<typeof fakeDocument>;
beforeEach(() => {
  vi.useFakeTimers();
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startPolling", () => {
  it("ticks now, then on the interval, and not while hidden", async () => {
    const tick = vi.fn();
    const poll = startPolling(tick, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(4);

    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    // At most the one tick already scheduled when the tab hid is skipped too.
    expect(tick).toHaveBeenCalledTimes(4);

    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(5); // immediately on return
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(6);

    poll.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(6);
    expect(doc.listeners.size).toBe(0);
  });

  it("follows a back-off schedule (last delay repeats) and reset() restarts it", async () => {
    const at: number[] = [];
    const poll = startPolling(() => void at.push(Date.now()), [100, 200, 400]);
    await vi.advanceTimersByTimeAsync(1500);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps.slice(0, 4)).toEqual([100, 200, 400, 400]);
    poll.reset();
    const n = at.length;
    await vi.advanceTimersByTimeAsync(400 + 100);
    // The pending (400 ms) tick fires, then the schedule restarts at 100 ms.
    expect(at.length).toBe(n + 2);
    poll.stop();
  });
});

describe("polling provider", () => {
  it("backs off while the payload is unchanged and resets on a change", async () => {
    let value = 1;
    const fetcher = vi.fn(async () => ({ value, serverTime: Date.now() }));
    const seen: number[] = [];
    const stop = createPollingProvider().subscribe("track:x", fetcher, (s) => seen.push(s.data.value), {
      backoffMs: [100, 1000],
      // serverTime differs every time; only `value` counts as a change.
      changeKey: (d) => String(d.value),
    });
    // Ticks at 0, 100, 200 (the first payload counts as a change), then 1 s apart.
    await vi.advanceTimersByTimeAsync(1250);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(900);
    expect(fetcher).toHaveBeenCalledTimes(4); // backed off
    value = 2;
    await vi.advanceTimersByTimeAsync(100); // 2250: the 2200 tick sees the change
    expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1000); // 3250: the already-pending 1 s tick
    expect(fetcher).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(100); // 3350: back to the short delay
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(seen.at(-1)).toBe(2);
    stop();
  });

  it("does not poll a hidden tab", async () => {
    doc.visibilityState = "hidden";
    const fetcher = vi.fn(async () => 1);
    const stop = createPollingProvider().subscribe("kds:t:l", fetcher, () => {}, { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).not.toHaveBeenCalled();
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    stop();
  });
});

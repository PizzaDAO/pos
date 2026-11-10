/**
 * Visibility-aware polling (load-test fix: hidden screens and background tabs
 * kept polling at full rate).
 *
 * `startPolling(tick, delays)` runs `tick` now, then again after each delay,
 * but only while the page is visible: when the tab is hidden the next tick is
 * skipped and polling stops; when it becomes visible again it ticks at once and
 * starts over. `delays` is a fixed interval or a back-off schedule (the last
 * entry repeats); `reset()` returns to its first step (e.g. when the data
 * changed). `hiddenMs`: keep polling while hidden, at that slower interval,
 * instead of stopping (the kitchen board, whose new-order chime must fire on a
 * minimised screen). Server-side / without `document` it simply polls.
 */

/** True when a browser document exists and is hidden. */
export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export interface PollHandle {
  /** Stop polling (idempotent). */
  stop: () => void;
  /** Back to the first delay of the schedule. */
  reset: () => void;
}

export function startPolling(
  tick: () => void | Promise<void>,
  delays: number | readonly number[],
  opts?: { hiddenMs?: number },
): PollHandle {
  const schedule = typeof delays === "number" ? [delays] : delays;
  let step = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const scheduleNext = (hidden = false) => {
    clear();
    if (stopped) return;
    const ms = hidden
      ? (opts?.hiddenMs as number)
      : (schedule[Math.min(step, schedule.length - 1)] ?? 4000);
    step += 1;
    timer = setTimeout(run, ms);
  };
  const run = () => {
    timer = null;
    if (stopped) return;
    const hidden = isPageHidden();
    // Hidden: stop until the page is visible again (see onVisibility), unless
    // the caller asked for a slow hidden poll.
    if (hidden && !opts?.hiddenMs) return;
    void Promise.resolve()
      .then(tick)
      .catch(() => undefined);
    scheduleNext(hidden);
  };
  const onVisibility = () => {
    if (stopped || isPageHidden()) return;
    step = 0;
    clear();
    run();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  run();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clear();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
    reset: () => {
      step = 0;
    },
  };
}

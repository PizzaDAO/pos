import { describe, expect, it } from "vitest";
import { mapChunks } from "./paging";

describe("mapChunks", () => {
  it("keeps chunk order and caps concurrency", async () => {
    let running = 0;
    let peak = 0;
    const ids = Array.from({ length: 1050 }, (_, i) => i);
    const out = await mapChunks(
      ids,
      100,
      async (chunk) => {
        running += 1;
        peak = Math.max(peak, running);
        // Later chunks finish first: order must still follow the input.
        await new Promise((r) => setTimeout(r, 20 - chunk[0]! / 100));
        running -= 1;
        return chunk;
      },
      4,
    );
    expect(out).toHaveLength(11);
    expect(out.flat()).toEqual(ids);
    expect(peak).toBe(4);
  });

  it("returns nothing for no items", async () => {
    expect(await mapChunks([], 100, async () => 1)).toEqual([]);
  });
});

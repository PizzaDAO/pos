import { describe, it, expect } from "vitest";
import type { Payment } from "@/lib/db";
import {
  cardPhase,
  isLiveCardTender,
  lastErrorOf,
  pickReader,
  readerStorageKey,
  shouldPoll,
  tenderStorageKey,
  type ReaderInfo,
} from "./use-card-reader";

const tender = (status: string, raw: Record<string, unknown> | null = null) =>
  ({ id: "p1", status, raw }) as unknown as Payment;

const reader = (id: string): ReaderInfo => ({
  id,
  label: id,
  deviceType: null,
  status: "online",
  simulated: false,
});

describe("card tender phase", () => {
  it("has no panel state without a tender", () => {
    expect(cardPhase(null)).toBe("idle");
    expect(isLiveCardTender(null)).toBe(false);
  });

  it("shows 'present card' while the reader waits", () => {
    expect(cardPhase(tender("requires_action"))).toBe("present");
    expect(cardPhase(tender("pending"))).toBe("present");
    expect(shouldPoll(tender("requires_action"))).toBe(true);
  });

  it("a decline keeps the tender open with last_error, and stops polling", () => {
    const declined = tender("requires_action", {
      last_error: { code: "card_declined", message: "Your card was declined." },
    });
    expect(cardPhase(declined)).toBe("declined");
    expect(isLiveCardTender(declined)).toBe(true);
    expect(lastErrorOf(declined)?.message).toBe("Your card was declined.");
    expect(shouldPoll(declined)).toBe(false);
  });

  it("captured is approved; canceled/failed are idle and not live", () => {
    expect(cardPhase(tender("captured"))).toBe("approved");
    expect(isLiveCardTender(tender("captured"))).toBe(false);
    expect(cardPhase(tender("canceled"))).toBe("idle");
    expect(cardPhase(tender("failed"))).toBe("idle");
    expect(shouldPoll(tender("captured"))).toBe(false);
  });
});

describe("reader selection", () => {
  it("keeps the remembered reader while it still exists", () => {
    expect(pickReader([reader("a"), reader("b")], "b")).toBe("b");
  });

  it("auto-picks when there is exactly one reader", () => {
    expect(pickReader([reader("a")], null)).toBe("a");
    expect(pickReader([reader("a")], "gone")).toBe("a");
  });

  it("makes the cashier choose when several readers and no valid memory", () => {
    expect(pickReader([reader("a"), reader("b")], null)).toBeNull();
    expect(pickReader([reader("a"), reader("b")], "gone")).toBeNull();
    expect(pickReader([], "a")).toBeNull();
  });
});

describe("storage keys", () => {
  it("scopes the reader per location and the in-flight tender per order", () => {
    expect(readerStorageKey("loc1")).toBe("pos.reader.loc1");
    expect(tenderStorageKey("ord1")).toBe("pos.cardTender.ord1");
    expect(tenderStorageKey("ord1")).not.toBe(tenderStorageKey("ord2"));
  });
});

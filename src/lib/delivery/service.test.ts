import { describe, it, expect } from "vitest";
import { pickProvider, quoteDelivery } from "@/lib/delivery/service";
import { DeliveryUnavailableError } from "@/lib/delivery/errors";
import {
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  type DeliveryAddress,
} from "@/lib/db";

const pickup: DeliveryAddress = {
  line1: "123 Main St",
  city: "Springfield",
  region: "NY",
  postal_code: "10001",
  country: "US",
};

function dropoff(postal: string): DeliveryAddress {
  return { ...pickup, line1: "9 Elm St", postal_code: postal };
}

describe("pickProvider", () => {
  it("selects the first available configured provider (in-house for downtown)", async () => {
    const provider = await pickProvider(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    expect(provider).toBe("in_house_manual");
  });

  it("returns null when the location offers no providers (uptown is pickup-only)", async () => {
    const provider = await pickProvider(
      DEMO_TENANT_ID,
      DEMO_LOCATION_UPTOWN_ID,
    );
    expect(provider).toBeNull();
  });
});

describe("quoteDelivery", () => {
  it("quotes a fee + ETA for an in-zone address", async () => {
    const { provider, quote } = await quoteDelivery({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      pickup,
      dropoff: dropoff("10001"),
      subtotalCents: 2500,
      currency: "USD",
    });
    expect(provider).toBe("in_house_manual");
    expect(quote.fee?.amount).toBe(399);
    expect(quote.etaMinutes).toBe(30);
  });

  it("rejects an out-of-zone address with DeliveryUnavailableError", async () => {
    await expect(
      quoteDelivery({
        tenantId: DEMO_TENANT_ID,
        locationId: DEMO_LOCATION_DOWNTOWN_ID,
        pickup,
        dropoff: dropoff("99999"),
        subtotalCents: 2500,
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
  });

  it("rejects an in-zone order below the zone minimum", async () => {
    await expect(
      quoteDelivery({
        tenantId: DEMO_TENANT_ID,
        locationId: DEMO_LOCATION_DOWNTOWN_ID,
        pickup,
        dropoff: dropoff("10010"), // far zone, $20 minimum
        subtotalCents: 1500,
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
  });

  it("throws a plain error when delivery is unavailable at the location", async () => {
    await expect(
      quoteDelivery({
        tenantId: DEMO_TENANT_ID,
        locationId: DEMO_LOCATION_UPTOWN_ID,
        pickup,
        dropoff: dropoff("10001"),
        subtotalCents: 2500,
        currency: "USD",
      }),
    ).rejects.toThrow(/not available/i);
  });
});

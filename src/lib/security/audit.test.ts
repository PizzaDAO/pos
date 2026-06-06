import { describe, it, expect } from "vitest";
import { recordAudit } from "./audit";
import { getPosDriver, DEMO_TENANT_ID } from "@/lib/db";

describe("recordAudit", () => {
  it("appends a tenant-scoped entry via the active driver", async () => {
    const entry = await recordAudit({
      actor: { id: "u1", label: "owner@example.com" },
      action: "payment_refund",
      tenantId: DEMO_TENANT_ID,
      detail: "Refunded 500¢ on payment p1.",
    });
    expect(entry).not.toBeNull();
    expect(entry?.tenant_id).toBe(DEMO_TENANT_ID);
    expect(entry?.action).toBe("payment_refund");

    const log = await getPosDriver().listAuditLog(DEMO_TENANT_ID);
    expect(log.some((e) => e.id === entry?.id)).toBe(true);
  });

  it("truncates an oversized detail string", async () => {
    const entry = await recordAudit({
      actor: { id: "u1", label: "x" },
      action: "menu_86",
      tenantId: DEMO_TENANT_ID,
      detail: "z".repeat(5000),
    });
    expect(entry?.detail?.length).toBeLessThanOrEqual(500);
  });

  it("is fail-open: returns null instead of throwing on a driver error", async () => {
    const driver = getPosDriver();
    const original = driver.appendAuditLog;
    // Force a failure in the append path.
    driver.appendAuditLog = async () => {
      throw new Error("db down");
    };
    try {
      const entry = await recordAudit({
        actor: { id: "u1", label: "x" },
        action: "auth_sign_in",
        tenantId: DEMO_TENANT_ID,
      });
      expect(entry).toBeNull();
    } finally {
      driver.appendAuditLog = original;
    }
  });
});

import { describe, expect, it } from "vitest";
import { DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { GENERIC_TEMPLATE_CSV } from "@/lib/menu-import";
import { POST } from "./route";

function upload(fields: Record<string, string>, file?: { name: string; body: string | Uint8Array }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", new File([file.body as BlobPart], file.name));
  return new Request("http://localhost/api/admin/menu/import", { method: "POST", body: form });
}
const csv = { name: "menu.csv", body: GENERIC_TEMPLATE_CSV };

describe("POST /api/admin/menu/import", () => {
  it("previews without writing", async () => {
    const before = await getPosDriver().getMenuSnapshot(DEMO_TENANT_ID);
    const res = await POST(upload({ tenantId: DEMO_TENANT_ID, action: "preview" }, csv));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.stats.items).toBe(4);
    expect(data.plan.formatLabel).toBe("Generic CSV template");
    expect(data.summary.replace.items).toBe(4);
    expect(data.existing.items).toBe(before.items.length);
    expect(await getPosDriver().getMenuSnapshot(DEMO_TENANT_ID)).toEqual(before);
  });

  it("rejects a tenant the caller does not belong to", async () => {
    const { tenant } = await getPosDriver().createTenant({
      businessName: "Not Mine Pizza",
      ownerEmail: "someone@notmine.example",
    });
    const res = await POST(upload({ tenantId: tenant.id, action: "apply", mode: "add" }, csv));
    expect(res.status).toBe(403);
    expect((await getPosDriver().getMenuSnapshot(tenant.id)).items).toHaveLength(0);
  });

  it("validates inputs", async () => {
    expect((await POST(upload({ tenantId: DEMO_TENANT_ID, action: "nope" }, csv))).status).toBe(422);
    expect((await POST(upload({ tenantId: DEMO_TENANT_ID, action: "preview" }))).status).toBe(400);
    expect((await POST(upload({ tenantId: DEMO_TENANT_ID, action: "preview", format: "x" }, csv))).status).toBe(422);
    expect((await POST(upload({ tenantId: DEMO_TENANT_ID, action: "apply" }, csv))).status).toBe(422);
    const bad = await POST(upload({ tenantId: DEMO_TENANT_ID, action: "preview" }, { name: "x.csv", body: "foo,bar\n1,2\n" }));
    expect(bad.status).toBe(422);
    const big = await POST(
      upload({ tenantId: DEMO_TENANT_ID, action: "preview" }, { name: "big.csv", body: new Uint8Array(2 * 1024 * 1024 + 1) }),
    );
    expect(big.status).toBe(413);
  });

  it("replace needs the server-side confirmation flag", async () => {
    const before = await getPosDriver().getMenuSnapshot(DEMO_TENANT_ID);
    const res = await POST(upload({ tenantId: DEMO_TENANT_ID, action: "apply", mode: "replace" }, csv));
    expect(res.status).toBe(422);
    expect(await getPosDriver().getMenuSnapshot(DEMO_TENANT_ID)).toEqual(before);
  });

  it("applies add then replace, auditing each", async () => {
    const driver = getPosDriver();
    const added = await POST(upload({ tenantId: DEMO_TENANT_ID, action: "apply", mode: "add" }, csv));
    expect(added.status).toBe(200);
    const again = await (await POST(upload({ tenantId: DEMO_TENANT_ID, action: "apply", mode: "add" }, csv))).json();
    expect(again.summary).toMatchObject({ items: 0, skippedItems: 4 });

    const replaced = await POST(
      upload({ tenantId: DEMO_TENANT_ID, action: "apply", mode: "replace", confirmReplace: "yes" }, csv),
    );
    expect(replaced.status).toBe(200);
    const snap = await driver.getMenuSnapshot(DEMO_TENANT_ID);
    expect(snap.items.map((i) => i.name).sort()).toEqual(["Cola", "Garlic Knots", "Margherita", "Pepperoni"]);

    const audit = (await driver.listAuditLog(DEMO_TENANT_ID)).filter((a) => a.action === "menu_import");
    expect(audit).toHaveLength(3);
    expect(audit.some((a) => /replace/.test(a.detail ?? "") && /replaced \d+ items/.test(a.detail ?? ""))).toBe(true);
  });
});

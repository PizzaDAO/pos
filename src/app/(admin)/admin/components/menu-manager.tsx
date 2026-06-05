/**
 * Menu management (Phase 5, /admin → Menu).
 *
 * CRUD over the tenant menu — categories, items (+ half-and-half flag + station),
 * sizes/base prices, modifier groups (+ half support), and modifiers — plus
 * PER-LOCATION overrides: a price override and an availability toggle ("86")
 * for items, sizes, and modifiers at the selected location. Edits go through
 * /api/admin/menu + /api/admin/overrides and reflect in terminal/shop reads
 * because the driver folds overrides into getMenu. No env vars.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type {
  LocationMenuOverride,
  MenuCategory,
  MenuCategoryWithItems,
  MenuItemDetail,
  MenuModifierGroup,
  Modifier,
  ModifierGroup,
  Station,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface Props {
  tenantId: string;
  locationId: string;
}

interface MenuData {
  categories: MenuCategory[];
  modifierGroups: ModifierGroup[];
  menu: { categories: MenuCategoryWithItems[] };
}

const STATIONS: Station[] = ["oven", "cold", "fryer", "expo", "none"];

function dollarsToCents(v: string): number {
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

export function MenuManager({ tenantId, locationId }: Props) {
  const [data, setData] = useState<MenuData | null>(null);
  const [overrides, setOverrides] = useState<LocationMenuOverride[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [menuRes, ovRes] = await Promise.all([
      fetch(
        `/api/admin/menu?tenantId=${tenantId}&locationId=${locationId}`,
        { cache: "no-store" },
      ),
      fetch(
        `/api/admin/overrides?tenantId=${tenantId}&locationId=${locationId}`,
        { cache: "no-store" },
      ),
    ]);
    if (menuRes.ok) setData((await menuRes.json()) as MenuData);
    if (ovRes.ok) {
      const d = (await ovRes.json()) as { overrides: LocationMenuOverride[] };
      setOverrides(d.overrides);
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const overrideFor = useCallback(
    (type: LocationMenuOverride["target_type"], id: string) =>
      overrides.find((o) => o.target_type === type && o.target_id === id) ??
      null,
    [overrides],
  );

  async function mutate(body: unknown) {
    setBusy(true);
    try {
      await fetch("/api/admin/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setOverride(input: {
    target_type: LocationMenuOverride["target_type"];
    target_id: string;
    price_cents?: number | null;
    available?: boolean | null;
  }) {
    setBusy(true);
    try {
      await fetch("/api/admin/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: tenantId,
          location_id: locationId,
          ...input,
        }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride(
    type: LocationMenuOverride["target_type"],
    id: string,
  ) {
    setBusy(true);
    try {
      await fetch(
        `/api/admin/overrides?tenantId=${tenantId}&locationId=${locationId}&targetType=${type}&targetId=${id}`,
        { method: "DELETE" },
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-muted-foreground">Loading menu…</p>;

  // Map item id → detail (sizes/modifier groups) from the assembled menu.
  const detailByItem = new Map<string, MenuItemDetail>();
  for (const cat of data.menu.categories) {
    for (const item of cat.items) detailByItem.set(item.id, item);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Menu management</h2>
          <p className="text-sm text-muted-foreground">
            Tenant menu (shared) with per-location price + availability overrides.
            Changes flow straight to the terminal &amp; shop.
          </p>
        </div>
        <AddCategory disabled={busy} onAdd={(name) => mutate({ entity: "category", action: "upsert", payload: { tenant_id: tenantId, name } })} />
      </div>

      <div className="space-y-6">
        {data.categories.map((cat) => (
          <CategoryCard
            key={cat.id}
            category={cat}
            items={detailByItem}
            menuCategory={data.menu.categories.find((c) => c.id === cat.id) ?? null}
            modifierGroups={data.modifierGroups}
            busy={busy}
            overrideFor={overrideFor}
            onMutate={mutate}
            onSetOverride={setOverride}
            onClearOverride={clearOverride}
          />
        ))}
      </div>

      <ModifierGroupsSection
        groups={data.modifierGroups}
        menu={data.menu.categories}
        busy={busy}
        overrideFor={overrideFor}
        onMutate={mutate}
        onSetOverride={setOverride}
        onClearOverride={clearOverride}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddCategory({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex gap-2">
      <input
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="New category"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        size="sm"
        disabled={disabled || !name.trim()}
        onClick={() => {
          onAdd(name.trim());
          setName("");
        }}
      >
        <Plus className="h-4 w-4" /> Category
      </Button>
    </div>
  );
}

interface MutateFn {
  (body: unknown): Promise<void>;
}
interface OverrideFns {
  overrideFor: (
    type: LocationMenuOverride["target_type"],
    id: string,
  ) => LocationMenuOverride | null;
  onSetOverride: (input: {
    target_type: LocationMenuOverride["target_type"];
    target_id: string;
    price_cents?: number | null;
    available?: boolean | null;
  }) => Promise<void>;
  onClearOverride: (
    type: LocationMenuOverride["target_type"],
    id: string,
  ) => Promise<void>;
}

function CategoryCard({
  category,
  menuCategory,
  modifierGroups,
  busy,
  overrideFor,
  onMutate,
  onSetOverride,
  onClearOverride,
}: {
  category: MenuCategory;
  items: Map<string, MenuItemDetail>;
  menuCategory: MenuCategoryWithItems | null;
  modifierGroups: ModifierGroup[];
  busy: boolean;
  onMutate: MutateFn;
} & OverrideFns) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);

  return (
    <section className="rounded-xl border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                await onMutate({
                  entity: "category",
                  action: "upsert",
                  payload: { id: category.id, tenant_id: category.tenant_id, name, sort_order: category.sort_order },
                });
                setEditing(false);
              }}
            >
              Save
            </Button>
          </div>
        ) : (
          <h3 className="font-semibold">{category.name}</h3>
        )}
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={() => setEditing((v) => !v)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={() =>
              onMutate({ entity: "category", action: "delete", id: category.id })
            }
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="divide-y">
        {(menuCategory?.items ?? []).map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            busy={busy}
            modifierGroups={modifierGroups}
            overrideFor={overrideFor}
            onMutate={onMutate}
            onSetOverride={onSetOverride}
            onClearOverride={onClearOverride}
          />
        ))}
        <div className="px-4 py-3">
          <AddItem categoryId={category.id} tenantId={category.tenant_id} busy={busy} onMutate={onMutate} />
        </div>
      </div>
    </section>
  );
}

function AddItem({
  categoryId,
  tenantId,
  busy,
  onMutate,
}: {
  categoryId: string;
  tenantId: string;
  busy: boolean;
  onMutate: MutateFn;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex gap-2">
      <input
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="New item"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !name.trim()}
        onClick={async () => {
          await onMutate({
            entity: "item",
            action: "upsert",
            payload: { tenant_id: tenantId, category_id: categoryId, name: name.trim(), station: "oven" },
          });
          setName("");
        }}
      >
        <Plus className="h-4 w-4" /> Item
      </Button>
    </div>
  );
}

function ItemRow({
  item,
  busy,
  overrideFor,
  onMutate,
  onSetOverride,
  onClearOverride,
}: {
  item: MenuItemDetail;
  busy: boolean;
  modifierGroups: ModifierGroup[];
  onMutate: MutateFn;
} & OverrideFns) {
  const [open, setOpen] = useState(false);
  const ov = overrideFor("item", item.id);
  const eightySixed = ov?.available === false;

  return (
    <div className={cn("px-4 py-3", eightySixed && "bg-destructive/5")}>
      <div className="flex items-center justify-between">
        <button className="text-left" onClick={() => setOpen((v) => !v)}>
          <span className="font-medium">{item.name}</span>
          {eightySixed && (
            <span className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
              86&apos;d here
            </span>
          )}
          <span className="ml-2 text-xs text-muted-foreground">
            {item.station} · {item.is_half_and_half_capable ? "½&½" : "whole"} ·{" "}
            {item.sizes.length} size{item.sizes.length === 1 ? "" : "s"}
          </span>
        </button>
        <div className="flex gap-1">
          <Button
            variant={eightySixed ? "outline" : "ghost"}
            size="sm"
            disabled={busy}
            onClick={() =>
              eightySixed
                ? onClearOverride("item", item.id)
                : onSetOverride({ target_type: "item", target_id: item.id, available: false })
            }
            title={eightySixed ? "Un-86 (re-enable here)" : "86 (mark unavailable here)"}
          >
            {eightySixed ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
            {eightySixed ? "Un-86" : "86"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={() => onMutate({ entity: "item", action: "delete", id: item.id })}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {open && (
        <ItemEditor
          item={item}
          busy={busy}
          overrideFor={overrideFor}
          onMutate={onMutate}
          onSetOverride={onSetOverride}
          onClearOverride={onClearOverride}
        />
      )}
    </div>
  );
}

function ItemEditor({
  item,
  busy,
  overrideFor,
  onMutate,
  onSetOverride,
  onClearOverride,
}: {
  item: MenuItemDetail;
  busy: boolean;
  onMutate: MutateFn;
} & OverrideFns) {
  return (
    <div className="mt-3 space-y-4 rounded-lg bg-muted/30 p-3 text-sm">
      {/* Item-level fields */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={item.is_half_and_half_capable}
            disabled={busy}
            onChange={(e) =>
              onMutate({
                entity: "item",
                action: "upsert",
                payload: { id: item.id, tenant_id: item.tenant_id, category_id: item.category_id, name: item.name, is_half_and_half_capable: e.target.checked },
              })
            }
          />
          Half-and-half capable
        </label>
        <label className="flex items-center gap-2">
          Station
          <select
            className="rounded-md border bg-background px-2 py-1"
            value={item.station}
            disabled={busy}
            onChange={(e) =>
              onMutate({
                entity: "item",
                action: "upsert",
                payload: { id: item.id, tenant_id: item.tenant_id, category_id: item.category_id, name: item.name, station: e.target.value as Station },
              })
            }
          >
            {STATIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Sizes */}
      <div>
        <div className="mb-1 font-medium">Sizes &amp; base price</div>
        <div className="space-y-2">
          {item.sizes.map((size) => {
            const sov = overrideFor("size", size.id);
            return (
              <div key={size.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-[7rem]">{size.name}</span>
                <span className="text-muted-foreground">
                  base {formatMoney(size.price_cents)}
                </span>
                <span className="text-xs text-muted-foreground">| this location:</span>
                <input
                  className="w-24 rounded-md border bg-background px-2 py-1"
                  placeholder={(size.price_cents / 100).toFixed(2)}
                  defaultValue={
                    sov?.price_cents != null ? (sov.price_cents / 100).toFixed(2) : ""
                  }
                  disabled={busy}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val === "") {
                      if (sov?.price_cents != null) onClearOverride("size", size.id);
                      return;
                    }
                    onSetOverride({
                      target_type: "size",
                      target_id: size.id,
                      price_cents: dollarsToCents(val),
                    });
                  }}
                />
                {sov?.price_cents != null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onClearOverride("size", size.id)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> reset
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  onClick={() => onMutate({ entity: "size", action: "delete", id: size.id })}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            );
          })}
          <AddSize itemId={item.id} busy={busy} onMutate={onMutate} />
        </div>
      </div>
    </div>
  );
}

function AddSize({
  itemId,
  busy,
  onMutate,
}: {
  itemId: string;
  busy: boolean;
  onMutate: MutateFn;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="w-32 rounded-md border bg-background px-2 py-1"
        placeholder="Size name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-24 rounded-md border bg-background px-2 py-1"
        placeholder="9.99"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !name.trim() || !price.trim()}
        onClick={async () => {
          await onMutate({
            entity: "size",
            action: "upsert",
            payload: { item_id: itemId, name: name.trim(), price_cents: dollarsToCents(price) },
          });
          setName("");
          setPrice("");
        }}
      >
        <Plus className="h-3.5 w-3.5" /> Size
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModifierGroupsSection({
  groups,
  menu,
  busy,
  overrideFor,
  onMutate,
  onSetOverride,
  onClearOverride,
}: {
  groups: ModifierGroup[];
  menu: MenuCategoryWithItems[];
  busy: boolean;
  onMutate: MutateFn;
} & OverrideFns) {
  // Pull modifiers per group from the assembled menu (override-aware view used
  // only to enumerate modifier ids/prices; base prices come from the group view).
  const modsByGroup = new Map<string, Modifier[]>();
  for (const cat of menu) {
    for (const item of cat.items) {
      for (const g of item.modifierGroups as MenuModifierGroup[]) {
        if (!modsByGroup.has(g.id)) modsByGroup.set(g.id, g.modifiers);
      }
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Modifier groups</h2>
        <AddModifierGroup
          busy={busy}
          onAdd={(name, supportsHalf) =>
            onMutate({
              entity: "modifierGroup",
              action: "upsert",
              payload: { tenant_id: groups[0]?.tenant_id, name, supports_half: supportsHalf, min_select: 0, max_select: 10 },
            })
          }
        />
      </div>
      {groups.map((group) => (
        <div key={group.id} className="rounded-xl border">
          <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
            <div>
              <span className="font-semibold">{group.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                select {group.min_select}–{group.max_select}
                {group.supports_half && " · supports ½&½"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              onClick={() =>
                onMutate({ entity: "modifierGroup", action: "delete", id: group.id })
              }
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
          <div className="divide-y px-4 text-sm">
            {(modsByGroup.get(group.id) ?? []).map((mod) => {
              const mov = overrideFor("modifier", mod.id);
              const off = mov?.available === false;
              return (
                <div key={mod.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-[8rem] font-medium">{mod.name}</span>
                  <span className="text-muted-foreground">
                    +{formatMoney(mod.price_cents)}
                  </span>
                  <span className="text-xs text-muted-foreground">| here:</span>
                  <input
                    className="w-24 rounded-md border bg-background px-2 py-1"
                    placeholder={(mod.price_cents / 100).toFixed(2)}
                    defaultValue={mov?.price_cents != null ? (mov.price_cents / 100).toFixed(2) : ""}
                    disabled={busy}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val === "") {
                        if (mov?.price_cents != null) onClearOverride("modifier", mod.id);
                        return;
                      }
                      onSetOverride({ target_type: "modifier", target_id: mod.id, price_cents: dollarsToCents(val) });
                    }}
                  />
                  <Button
                    variant={off ? "outline" : "ghost"}
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      off
                        ? onClearOverride("modifier", mod.id)
                        : onSetOverride({ target_type: "modifier", target_id: mod.id, available: false })
                    }
                  >
                    {off ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                    {off ? "Un-86" : "86"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={() => onMutate({ entity: "modifier", action: "delete", id: mod.id })}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              );
            })}
            <div className="py-2">
              <AddModifier groupId={group.id} busy={busy} onMutate={onMutate} />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function AddModifierGroup({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, supportsHalf: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [half, setHalf] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="New group"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} />
        ½&½
      </label>
      <Button
        size="sm"
        disabled={busy || !name.trim()}
        onClick={() => {
          onAdd(name.trim(), half);
          setName("");
          setHalf(false);
        }}
      >
        <Plus className="h-4 w-4" /> Group
      </Button>
    </div>
  );
}

function AddModifier({
  groupId,
  busy,
  onMutate,
}: {
  groupId: string;
  busy: boolean;
  onMutate: MutateFn;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="w-36 rounded-md border bg-background px-2 py-1"
        placeholder="Modifier name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-24 rounded-md border bg-background px-2 py-1"
        placeholder="1.50"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !name.trim()}
        onClick={async () => {
          await onMutate({
            entity: "modifier",
            action: "upsert",
            payload: { group_id: groupId, name: name.trim(), price_cents: dollarsToCents(price || "0") },
          });
          setName("");
          setPrice("");
        }}
      >
        <Plus className="h-3.5 w-3.5" /> Modifier
      </Button>
    </div>
  );
}

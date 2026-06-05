/**
 * Renders an order's line items for the kitchen (board ticket + printed ticket).
 *
 * Handles:
 *  - quantity + item name + size
 *  - half-and-half: whole-pie modifiers inline, LEFT/RIGHT modifiers split into
 *    labeled halves so the line cook sees exactly which side each topping is on
 *  - per-line notes
 *  - optional station filtering: when a `stationFilter` other than "all" is
 *    given, lines that don't route to it are hidden so a station only sees its
 *    own work.
 */
import type { OrderItem } from "@/lib/db";
import { lineMatchesStation } from "@/lib/kds/board";
import type { StationFilter } from "@/lib/kds/types";
import {
  groupModifiersByPlacement,
  isHalfAndHalf,
} from "@/lib/kds/format";

function ModifierList({
  label,
  mods,
}: {
  label?: string;
  mods: { modifier_id: string; modifier_name: string }[];
}) {
  if (mods.length === 0) return null;
  return (
    <div className="text-sm leading-snug">
      {label && (
        <span className="mr-1 font-semibold uppercase tracking-wide text-foreground">
          {label}:
        </span>
      )}
      <span className="text-muted-foreground">
        {mods.map((m) => m.modifier_name).join(", ")}
      </span>
    </div>
  );
}

function LineRow({ line }: { line: OrderItem }) {
  const grouped = groupModifiersByPlacement(line.modifiers);
  const half = isHalfAndHalf(line.modifiers);

  return (
    <li className="border-b border-dashed py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">
          {line.quantity > 1 && (
            <span className="mr-1 rounded bg-foreground px-1.5 text-background">
              {line.quantity}×
            </span>
          )}
          {line.item_name}
        </span>
        {line.size_name && (
          <span className="text-sm text-muted-foreground">
            {line.size_name}
          </span>
        )}
      </div>

      <div className="mt-0.5 space-y-0.5 pl-1">
        {/* Whole-pie modifiers (crust/sauce/whole toppings). */}
        <ModifierList mods={grouped.whole} />

        {half && (
          <div className="mt-1 grid grid-cols-2 gap-1 rounded border border-foreground/30 p-1">
            <div className="border-r border-foreground/30 pr-1">
              <ModifierList label="Left" mods={grouped.left} />
            </div>
            <div className="pl-1">
              <ModifierList label="Right" mods={grouped.right} />
            </div>
          </div>
        )}

        {line.notes && (
          <div className="text-sm font-medium italic text-amber-700">
            ⚑ {line.notes}
          </div>
        )}
      </div>
    </li>
  );
}

export function TicketItems({
  items,
  stationFilter = "all",
}: {
  items: OrderItem[];
  stationFilter?: StationFilter;
}) {
  const visible = items.filter(
    (i) => !i.voided && lineMatchesStation(i, stationFilter),
  );

  if (visible.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No items for this station.
      </p>
    );
  }

  return (
    <ul className="divide-y-0">
      {visible.map((line) => (
        <LineRow key={line.id} line={line} />
      ))}
    </ul>
  );
}

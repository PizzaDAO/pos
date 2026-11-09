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
  withoutDefaultModifiers,
} from "@/lib/kds/format";

const NO_DEFAULTS: ReadonlySet<string> = new Set();

function ModifierList({
  label,
  mods,
}: {
  label?: string;
  mods: { modifier_id: string; modifier_name: string }[];
}) {
  if (mods.length === 0) return null;
  return (
    <div className="text-base leading-snug">
      {label && (
        <span className="mr-1 font-semibold uppercase tracking-wide text-foreground">
          {label}:
        </span>
      )}
      <span className="text-foreground">
        {mods.map((m) => m.modifier_name).join(", ")}
      </span>
    </div>
  );
}

function LineRow({
  line,
  defaultIds,
}: {
  line: OrderItem;
  defaultIds: ReadonlySet<string>;
}) {
  // Only changes from the standard pie (default crust/sauce are hidden).
  const mods = withoutDefaultModifiers(line.modifiers, defaultIds);
  const grouped = groupModifiersByPlacement(mods);
  const half = isHalfAndHalf(mods);

  return (
    <li className="border-b border-dashed py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-semibold">
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
          <div className="mt-1 grid grid-cols-1 gap-1 rounded border border-foreground/30 p-1">
            <div className="border-b border-foreground/30 pb-1">
              <ModifierList label="Left" mods={grouped.left} />
            </div>
            <div>
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
  defaultModifierIds = NO_DEFAULTS,
}: {
  items: OrderItem[];
  stationFilter?: StationFilter;
  /** Modifier ids that are the group default; hidden from the ticket. */
  defaultModifierIds?: ReadonlySet<string>;
}) {
  const visible = items.filter(
    (i) => !i.voided && lineMatchesStation(i, stationFilter),
  );
  // Lines voided AFTER they were sent: shown struck through so the cook stops.
  const stopped = items.filter(
    (i) => i.voided && !!i.fired_at && lineMatchesStation(i, stationFilter),
  );

  if (visible.length === 0 && stopped.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No items for this station.
      </p>
    );
  }

  return (
    <ul className="divide-y-0">
      {visible.map((line) => (
        <LineRow key={line.id} line={line} defaultIds={defaultModifierIds} />
      ))}
      {stopped.map((line) => (
        <li
          key={line.id}
          data-testid="voided-line"
          className="flex items-baseline justify-between gap-2 border-b border-dashed py-2 last:border-b-0"
        >
          <span className="text-lg text-muted-foreground line-through">
            {line.quantity > 1 && `${line.quantity}× `}
            {line.item_name}
            {line.size_name && ` · ${line.size_name}`}
          </span>
          <span className="rounded bg-destructive px-1.5 text-xs font-bold uppercase text-destructive-foreground">
            Void
          </span>
        </li>
      ))}
    </ul>
  );
}

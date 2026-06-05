/**
 * Tip selector — preset % (computed off the base amount the tip applies to) +
 * custom amount entry. Emits the tip in integer cents.
 */
"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatMoney, roundHalfUp } from "@/lib/pricing";

export function TipSelector({
  baseCents,
  presetsBps,
  currency,
  tipCents,
  onChange,
}: {
  /** Amount the tip percentage is computed against (the remaining balance). */
  baseCents: number;
  presetsBps: number[];
  currency: string;
  tipCents: number;
  onChange: (cents: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const [mode, setMode] = useState<"preset" | "custom">("preset");

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-muted-foreground">Tip</div>
      <div className="grid grid-cols-4 gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("preset");
            onChange(0);
          }}
          className={cn(
            "rounded-md border py-2 text-sm",
            mode === "preset" && tipCents === 0 && "border-primary bg-primary/10",
          )}
        >
          None
        </button>
        {presetsBps.map((bps) => {
          const cents = roundHalfUp((baseCents * bps) / 10_000);
          const active = mode === "preset" && tipCents === cents && cents > 0;
          return (
            <button
              key={bps}
              type="button"
              onClick={() => {
                setMode("preset");
                onChange(cents);
              }}
              className={cn(
                "rounded-md border py-2 text-sm",
                active && "border-primary bg-primary/10",
              )}
            >
              {(bps / 100).toFixed(0)}%
              <span className="block text-xs text-muted-foreground">
                {formatMoney(cents, currency)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Custom $</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={custom}
          onChange={(e) => {
            setMode("custom");
            setCustom(e.target.value);
            const v = parseFloat(e.target.value);
            onChange(Number.isFinite(v) ? Math.max(0, Math.round(v * 100)) : 0);
          }}
          placeholder="0.00"
          className={cn(
            "w-28 rounded-md border bg-background px-2 py-1 text-right text-sm",
            mode === "custom" && "border-primary",
          )}
        />
      </div>
    </div>
  );
}

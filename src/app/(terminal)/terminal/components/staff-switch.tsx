/**
 * Staff PIN quick-switch (terminal). The cashier picks who they are and types a
 * 4–8 digit PIN; verification happens SERVER-SIDE (/api/terminal/pin) against
 * `staff.pin_hash` — the hash never reaches this component. On success the active
 * staff is attributed to subsequently placed orders.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { ActiveStaff } from "@/lib/store/use-active-staff";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface StaffOption {
  id: string;
  tenant_id?: string;
  name: string;
  role: string;
}

export function StaffSwitch({
  tenantId,
  current,
  onVerify,
  onSignOut,
  onClose,
}: {
  /** The terminal's tenant (the picker lists only its staff). */
  tenantId?: string;
  current: ActiveStaff | null;
  onVerify: (staffId: string, pin: string) => Promise<boolean>;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffState, setStaffState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reloadKey, setReloadKey] = useState(0);
  const busyRef = useRef(false);
  const submitRef = useRef<() => void>(() => {});
  const [selected, setSelected] = useState<string>(current?.id ?? "");
  const [pin, setPin] = useState("");
  const pinRef = useRef("");
  pinRef.current = pin;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  /** Keypad keys never take focus on click, so a later Enter/Space can't re-press one. */
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  function addDigit(d: string) {
    setError(null);
    setPin((p) => (p.length >= 8 ? p : p + d));
  }

  // Hardware keyboard still works (digits, Backspace).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busyRef.current) return;
      // With digits typed, Enter always submits (even if Close or a tile has
      // focus); with none, a focused control handles Enter natively.
      const onButton = e.target instanceof HTMLButtonElement;
      if (/^[0-9]$/.test(e.key)) addDigit(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter" && (!onButton || pinRef.current.length > 0)) {
        e.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    setStaffState("loading");
    fetch(
      tenantId
        ? `/api/terminal/pin?tenantId=${encodeURIComponent(tenantId)}`
        : "/api/terminal/pin",
    )
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { staff?: StaffOption[] }) => {
        if (!alive) return;
        setStaff(d.staff ?? []);
        setStaffState("ready");
      })
      .catch(() => {
        if (alive) setStaffState("error");
      });
    return () => {
      alive = false;
    };
  }, [tenantId, reloadKey]);

  async function submit() {
    if (busyRef.current) return;
    setError(null);
    if (!selected) {
      setError("Choose a staff member.");
      return;
    }
    if (!/^[0-9]{4,8}$/.test(pin)) {
      setError("Enter a 4–8 digit PIN.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const ok = await onVerify(selected, pin);
      if (ok) {
        setPin("");
        onClose();
      } else {
        setError("Incorrect PIN.");
        setPin("");
        setShake(true);
        setTimeout(() => setShake(false), 500);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  submitRef.current = () => void submit();

  return (
    <Dialog onClose={onClose} labelledBy="staff-switch-title">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="staff-switch-title" className="text-lg font-semibold">
            Switch staff
          </h2>
          <Button
            variant="ghost"
            className="h-11 px-4"
            onClick={onClose}
          >
            Close
          </Button>
        </div>

        {current && (
          <p className="mb-3 text-sm text-muted-foreground">
            Active: <span className="font-medium">{current.name}</span> (
            {current.role})
          </p>
        )}

        <div className="mb-1 text-sm font-medium" id="staff-tiles-label">
          Staff member
        </div>
        <div
          role="group"
          aria-labelledby="staff-tiles-label"
          className="mb-4 grid grid-cols-2 gap-2"
        >
          {staffState === "loading" && (
            <p className="col-span-2 text-sm text-muted-foreground">
              Loading staff…
            </p>
          )}
          {staffState === "error" && (
            <div role="alert" className="col-span-2 text-sm text-destructive">
              Couldn&apos;t load staff.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {staffState === "ready" && staff.length === 0 && (
            <p className="col-span-2 text-sm text-muted-foreground">
              No staff with a PIN are set up for this location.
            </p>
          )}
          {staff.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={selected === s.id}
              onMouseDown={noFocus}
              onClick={() => {
                setSelected(s.id);
                setError(null);
              }}
              className={cn(
                "flex min-h-14 flex-col items-start justify-center rounded-lg border px-3 py-2 text-left touch-manipulation",
                selected === s.id
                  ? "border-primary bg-primary/10 ring-2 ring-primary"
                  : "hover:bg-secondary",
              )}
            >
              <span className="text-base font-semibold">{s.name}</span>
              <span className="text-xs capitalize text-muted-foreground">
                {s.role}
              </span>
            </button>
          ))}
        </div>

        <div className="mb-1 text-sm font-medium" aria-hidden="true">
          PIN
        </div>
        <div
          id="staff-pin"
          role="img"
          aria-label={`PIN, ${pin.length} digit${pin.length === 1 ? "" : "s"} entered`}
          aria-describedby={error ? "staff-pin-error" : undefined}
          className={cn(
            "mb-3 flex h-12 items-center justify-center gap-3 rounded-md border bg-background",
            shake && "animate-pulse border-destructive",
          )}
        >
          {pin.length === 0 ? (
            <span className="text-muted-foreground" aria-hidden="true">
              Enter PIN
            </span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="h-3.5 w-3.5 rounded-full bg-foreground"
              />
            ))
          )}
        </div>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <button
              key={d}
              type="button"
              aria-label={d}
              disabled={busy}
              onMouseDown={noFocus}
              onClick={() => addDigit(d)}
              className="h-16 rounded-lg border text-2xl font-semibold touch-manipulation hover:bg-secondary active:bg-secondary disabled:opacity-50"
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            aria-label="Clear"
            disabled={busy}
            onMouseDown={noFocus}
            onClick={() => setPin("")}
            className="h-16 rounded-lg border text-base font-medium touch-manipulation hover:bg-secondary disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            aria-label="0"
            disabled={busy}
            onMouseDown={noFocus}
            onClick={() => addDigit("0")}
            className="h-16 rounded-lg border text-2xl font-semibold touch-manipulation hover:bg-secondary active:bg-secondary disabled:opacity-50"
          >
            0
          </button>
          <button
            type="button"
            aria-label="Backspace"
            disabled={busy}
            onMouseDown={noFocus}
            onClick={() => setPin((p) => p.slice(0, -1))}
            className="flex h-16 items-center justify-center rounded-lg border touch-manipulation hover:bg-secondary disabled:opacity-50"
          >
            <Delete className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>

        {error && (
          <p
            id="staff-pin-error"
            role="alert"
            className="mb-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          {current ? (
            <Button
              variant="outline"
              className="h-12 px-4"
              onClick={() => {
                onSignOut();
                onClose();
              }}
            >
              Sign out staff
            </Button>
          ) : (
            <span />
          )}
          <Button
            className="h-12 px-8 text-base"
            disabled={busy}
            onMouseDown={noFocus}
            onClick={() => void submit()}
          >
            {busy ? "Verifying…" : "Switch"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Staff PIN quick-switch (terminal). The cashier picks who they are and types a
 * 4–8 digit PIN; verification happens SERVER-SIDE (/api/terminal/pin) against
 * `staff.pin_hash` — the hash never reaches this component. On success the active
 * staff is attributed to subsequently placed orders.
 */
"use client";

import { useEffect, useState } from "react";
import type { ActiveStaff } from "@/lib/store/use-active-staff";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface StaffOption {
  id: string;
  tenant_id: string;
  name: string;
  role: string;
}

export function StaffSwitch({
  current,
  onVerify,
  onSignOut,
  onClose,
}: {
  current: ActiveStaff | null;
  onVerify: (staffId: string, pin: string) => Promise<boolean>;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selected, setSelected] = useState<string>(current?.id ?? "");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/terminal/pin")
      .then((r) => (r.ok ? r.json() : { staff: [] }))
      .then((d: { staff?: StaffOption[] }) => {
        if (alive) setStaff(d.staff ?? []);
      })
      .catch(() => {
        if (alive) setStaff([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submit() {
    setError(null);
    if (!selected) {
      setError("Choose a staff member.");
      return;
    }
    if (!/^[0-9]{4,8}$/.test(pin)) {
      setError("Enter a 4–8 digit PIN.");
      return;
    }
    setBusy(true);
    try {
      const ok = await onVerify(selected, pin);
      if (ok) {
        setPin("");
        onClose();
      } else {
        setError("Incorrect PIN.");
        setPin("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="staff-switch-title">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="staff-switch-title" className="text-lg font-semibold">
            Switch staff
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {current && (
          <p className="mb-3 text-sm text-muted-foreground">
            Active: <span className="font-medium">{current.name}</span> (
            {current.role})
          </p>
        )}

        <label
          htmlFor="staff-select"
          className="mb-1 block text-sm font-medium"
        >
          Staff member
        </label>
        <select
          id="staff-select"
          className="mb-3 w-full rounded-md border bg-background px-3 py-2"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Select…</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.role})
            </option>
          ))}
        </select>

        <label htmlFor="staff-pin" className="mb-1 block text-sm font-medium">
          PIN
        </label>
        <input
          id="staff-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "staff-pin-error" : undefined}
          className="mb-3 w-full rounded-md border bg-background px-3 py-2 tracking-widest"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="••••"
          maxLength={8}
        />

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
              size="sm"
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
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? "Verifying…" : "Switch"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

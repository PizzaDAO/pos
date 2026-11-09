/**
 * Back-office PIN lock (client) — the UI half of src/lib/auth/admin-gate.ts.
 *
 * The SERVER enforces the gate on the page and on every /api/admin/* route;
 * this component only decides what to show:
 *   - locked on arrival  → the owner/manager PIN pad alone (the shell is not
 *     mounted, so none of its requests fire unauthenticated);
 *   - unlocked           → a bar naming who unlocked it, a countdown and
 *     "Lock now", above the back office;
 *   - the unlock expires (10 minutes), is revoked, or the person is demoted →
 *     the PIN pad opens OVER the back office, keeping its state (an unsaved
 *     form survives a re-prompt).
 * Status is re-checked every 30s and when the tab regains focus.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { StaffSwitch } from "@/app/(terminal)/terminal/components/staff-switch";
import { PinReveal, SignInAgain } from "./staff-manager";
import { Button } from "@/components/ui/button";

export interface AdminLockState {
  /** Is the PIN gate in force for this tenant? */
  required: boolean;
  /** Real mode, PINs not set up yet: suggest setting an owner/manager PIN. */
  nudge: boolean;
  staff: { id: string; name: string; role: string } | null;
  expiresAt: string | null;
}

const ADMIN_PIN_ROLES = ["owner", "manager"] as const;

function minutesLeft(expiresAt: string | null, now: number): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

export function AdminLock({
  tenantId,
  initial,
  children,
}: {
  tenantId: string;
  initial: AdminLockState;
  children: React.ReactNode;
}) {
  const [state, setState] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const isLocked = (s: AdminLockState, t: number) =>
    s.required && (!s.staff || !s.expiresAt || Date.parse(s.expiresAt) <= t);
  const locked = isLocked(state, now);
  // Mount the back office only once it has been unlocked (or never needed it).
  const [shellMounted, setShellMounted] = useState(
    () => !isLocked(initial, Date.now()),
  );
  useEffect(() => {
    if (!locked) setShellMounted(true);
  }, [locked]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/unlock?tenantId=${encodeURIComponent(tenantId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const d = (await res.json()) as {
        required: boolean;
        staff: AdminLockState["staff"];
        expiresAt: string | null;
      };
      setState((s) => ({
        ...s,
        required: d.required,
        staff: d.staff,
        expiresAt: d.expiresAt,
      }));
      setNow(Date.now());
    } catch {
      // Offline: keep the local view; the server still enforces the gate.
    }
  }, [tenantId]);

  // Tick (countdown + local expiry), periodic re-check, and re-check on focus.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const poll = setInterval(() => void refresh(), 30_000);
    const onFocus = () => {
      setNow(Date.now());
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  // Lock exactly at expiry, not up to one tick late.
  useEffect(() => {
    if (!state.expiresAt) return;
    const ms = Date.parse(state.expiresAt) - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), ms + 50);
    return () => clearTimeout(t);
  }, [state.expiresAt]);

  // The PIN pad calls onClose right after a successful verify, before the
  // unlocked state has rendered: remember the success so "close" isn't "leave".
  const verified = useRef(false);
  /** A PIN to show once (a replaced short PIN, or an owner's first PIN). */
  const [revealed, setRevealed] = useState<{
    name: string;
    pin: string;
  } | null>(null);

  async function unlock(
    staffId: string,
    pin: string,
  ): Promise<boolean | string> {
    const res = await fetch("/api/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId, staffId, pin }),
    });
    if (res.ok) {
      const d = (await res.json()) as {
        staff: NonNullable<AdminLockState["staff"]>;
        expiresAt: string;
        newPin?: string;
      };
      verified.current = true;
      // A short PIN was replaced by the server: show the new one once.
      if (d.newPin) setRevealed({ name: d.staff.name, pin: d.newPin });
      setState((s) => ({ ...s, staff: d.staff, expiresAt: d.expiresAt }));
      setNow(Date.now());
      return true;
    }
    if (res.status === 401) return false;
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    return d.error ?? "Could not unlock. Try again.";
  }

  async function lockNow() {
    await fetch("/api/admin/unlock", { method: "DELETE" }).catch(() => null);
    setState((s) => ({ ...s, staff: null, expiresAt: null }));
  }

  return (
    <>
      {state.required && state.staff && !locked && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-1.5 text-xs"
        >
          <span>
            Unlocked by <strong>{state.staff.name}</strong> ({state.staff.role})
            · locks in {minutesLeft(state.expiresAt, now)} min
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-9 px-3"
            onClick={() => void lockNow()}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Lock now
          </Button>
        </div>
      )}
      {state.nudge && !state.required && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-500/50 bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-900 dark:text-amber-200">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Anyone at a till signed in as you can open the back office. Give an
          owner a PIN (Staff &amp; drawer) to require it here.
        </div>
      )}

      {shellMounted && children}

      {locked && (
        <StaffSwitch
          tenantId={tenantId}
          current={null}
          roles={ADMIN_PIN_ROLES}
          title="Unlock the back office"
          intro={
            <>
              <p>
                {shellMounted
                  ? "The back office locked itself. Enter an owner or manager PIN to carry on."
                  : "Enter an owner or manager PIN. The back office stays unlocked for 10 minutes."}
              </p>
              <OwnerPinSetup
                tenantId={tenantId}
                onIssued={(name, pin) => setRevealed({ name, pin })}
              />
            </>
          }
          submitLabel="Unlock"
          closeLabel="Leave"
          onVerify={unlock}
          onSignOut={() => {}}
          onClose={() => {
            if (verified.current) {
              verified.current = false;
              return;
            }
            // Leaving while still locked goes back to the till.
            window.location.assign("/terminal");
          }}
        />
      )}

      {revealed && <PinReveal {...revealed} onDone={() => setRevealed(null)} />}
    </>
  );
}

/**
 * An owner with no PIN yet sets one up from the lock screen
 * (/api/admin/owner-pin: owner login + a recent sign-in). Renders nothing for a
 * manager login or when every owner already has a PIN.
 */
function OwnerPinSetup({
  tenantId,
  onIssued,
}: {
  tenantId: string;
  onIssued: (name: string, pin: string) => void;
}) {
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/owner-pin?tenantId=${encodeURIComponent(tenantId)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : { owners: [] }))
      .then((d: { owners?: { id: string; name: string }[] }) => {
        if (alive) setOwners(d.owners ?? []);
      })
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [tenantId]);

  if (owners.length === 0) return null;

  async function issue(o: { id: string; name: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/owner-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, staffId: o.id }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        pin?: string;
        error?: string;
        code?: string;
      };
      if (res.ok && d.pin) {
        setOwners((cur) => cur.filter((x) => x.id !== o.id));
        onIssued(o.name, d.pin);
        return;
      }
      setReauth(d.code === "reauth_required");
      setError(d.error ?? "Could not set the PIN.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border p-2">
      <p className="text-xs">Owner without a PIN yet? Set one up:</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {owners.map((o) => (
          <Button
            key={o.id}
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy}
            onClick={() => void issue(o)}
          >
            Set PIN for {o.name}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {reauth && (
        <div className="mt-1">
          <SignInAgain />
        </div>
      )}
    </div>
  );
}

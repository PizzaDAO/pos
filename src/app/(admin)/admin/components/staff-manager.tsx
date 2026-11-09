/**
 * Staff roster management (/admin → Staff & drawer): add, edit, deactivate /
 * reactivate (never delete: history references staff), reset a PIN (shown
 * once), and each member's last PIN sign-in. Talks to /api/admin/staff.
 *
 * The server enforces every rule (src/lib/staff/manage.ts): owner|manager
 * only, managers can't create or change owners, the last owner can't be
 * demoted or deactivated. This component only hides what the acting role
 * can't do, and shows the server's message when it refuses.
 */
"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, Pencil, Plus, UserCheck, UserX, Users } from "lucide-react";
import type {
  Location,
  MembershipRole,
  Staff,
  StaffModuleRole,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  tenantId: string;
  locationId: string;
  locations: Location[];
  /** Called after any roster change (so the drawer list refreshes). */
  onChanged?: () => void;
}

interface Actor {
  role: MembershipRole | null;
  staffId: string | null;
  name: string | null;
  gated: boolean;
}

interface RosterData {
  staff: Staff[];
  hasPin: Record<string, boolean>;
  lastSignInAt: Record<string, string>;
  actor: Actor;
}

const ROLES: { role: MembershipRole; label: string }[] = [
  { role: "owner", label: "Owner" },
  { role: "manager", label: "Manager" },
  { role: "cashier", label: "Cashier" },
  { role: "kitchen", label: "Kitchen" },
];

const MODULE_ROLES: { role: StaffModuleRole; label: string }[] = [
  { role: "driver", label: "Driver" },
  { role: "dispatcher", label: "Dispatcher" },
];

/** Can the acting role touch this member at all? (Mirrors the server rule.) */
function canTouch(actor: Actor, s: Pick<Staff, "role">): boolean {
  if (actor.role === "owner") return true;
  return actor.role === "manager" && s.role !== "owner";
}

function formatSignIn(iso: string | undefined): string {
  if (!iso) return "Never signed in";
  return `Last sign-in ${new Date(iso).toLocaleString()}`;
}

export function StaffManager({
  tenantId,
  locationId,
  locations,
  onChanged,
}: Props) {
  const [data, setData] = useState<RosterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Staff | "new" | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<Staff | null>(
    null,
  );
  const [confirmReset, setConfirmReset] = useState<Staff | null>(null);
  const [revealed, setRevealed] = useState<{
    name: string;
    pin: string;
  } | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/staff?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      { cache: "no-store" },
    );
    if (res.ok) setData((await res.json()) as RosterData);
    else {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error ?? "Could not load staff.");
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** POST a management action; returns the parsed body on success, else null. */
  async function act(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, ...body }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof d.error === "string" ? d.error : "That didn't work.");
        return null;
      }
      await load();
      onChanged?.();
      return d;
    } finally {
      setBusy(false);
    }
  }

  async function resetPin(s: Staff) {
    const d = await act({ action: "resetPin", staffId: s.id });
    if (d && typeof d.pin === "string")
      setRevealed({ name: s.name, pin: d.pin });
  }

  if (!data) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading staff…</p>
    );
  }

  const { actor } = data;
  const active = data.staff.filter((s) => s.active);
  const inactive = data.staff.filter((s) => !s.active);
  const shown = showInactive ? [...active, ...inactive] : active;
  const anyAdminPin = active.some(
    (s) => (s.role === "owner" || s.role === "manager") && data.hasPin[s.id],
  );

  return (
    <section className="space-y-4" aria-labelledby="staff-roster-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2
          id="staff-roster-title"
          className="flex items-center gap-2 text-base font-semibold"
        >
          <Users className="h-5 w-5" aria-hidden="true" /> Staff
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {inactive.length > 0 && (
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setShowInactive((v) => !v)}
            >
              {showInactive ? "Hide" : "Show"} deactivated ({inactive.length})
            </Button>
          )}
          <Button
            className="h-11"
            disabled={busy}
            onClick={() => setEditing("new")}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add staff
          </Button>
        </div>
      </div>

      {!anyAdminPin && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          No owner or manager has a PIN yet. Reset a PIN for one to lock the
          back office behind it.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <ul className="divide-y overflow-hidden rounded-xl border">
        {shown.map((s) => {
          const touchable = canTouch(actor, s);
          return (
            <li
              key={s.id}
              className={cn(
                "flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between",
                !s.active && "bg-muted/40",
              )}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{s.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-foreground">
                    {s.role}
                  </span>
                  {(s.module_roles ?? []).map((r) => (
                    <span
                      key={r}
                      className="rounded-full border px-2 py-0.5 text-xs capitalize text-foreground"
                    >
                      {r}
                    </span>
                  ))}
                  {!s.active && (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                      Deactivated
                    </span>
                  )}
                  {actor.staffId === s.id && (
                    <span className="text-xs text-muted-foreground">(you)</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {[s.contact_email, s.contact_phone]
                    .filter(Boolean)
                    .join(" · ") || "No contact details"}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {data.hasPin[s.id] ? "PIN set" : "No PIN"} ·{" "}
                  {formatSignIn(data.lastSignInAt[s.id])}
                </div>
              </div>
              {touchable && (
                <div className="flex flex-wrap gap-2">
                  {s.active && (
                    <>
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={busy}
                        aria-label={`Edit ${s.name}`}
                        onClick={() => setEditing(s)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={busy}
                        aria-label={`${data.hasPin[s.id] ? "Reset" : "Set"} PIN for ${s.name}`}
                        onClick={() =>
                          data.hasPin[s.id]
                            ? setConfirmReset(s)
                            : void resetPin(s)
                        }
                      >
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        {data.hasPin[s.id] ? "Reset PIN" : "Set PIN"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-11"
                        disabled={busy}
                        aria-label={`Deactivate ${s.name}`}
                        onClick={() => setConfirmDeactivate(s)}
                      >
                        <UserX className="h-4 w-4" aria-hidden="true" />{" "}
                        Deactivate
                      </Button>
                    </>
                  )}
                  {!s.active && (
                    <Button
                      variant="outline"
                      className="h-11"
                      disabled={busy}
                      aria-label={`Reactivate ${s.name}`}
                      onClick={() =>
                        void act({ action: "reactivate", staffId: s.id })
                      }
                    >
                      <UserCheck className="h-4 w-4" aria-hidden="true" />{" "}
                      Reactivate
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="p-4 text-sm text-muted-foreground">
            No staff yet. Add someone.
          </li>
        )}
      </ul>

      {editing && (
        <StaffForm
          staff={editing === "new" ? null : editing}
          actor={actor}
          locations={locations}
          busy={busy}
          error={error}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
          onSave={async (fields) => {
            const d =
              editing === "new"
                ? await act({ action: "create", ...fields })
                : await act({
                    action: "update",
                    staffId: editing.id,
                    ...fields,
                  });
            if (!d) return;
            setEditing(null);
            if (typeof d.pin === "string") {
              setRevealed({ name: String(fields.name), pin: d.pin });
            }
          }}
        />
      )}

      {confirmDeactivate && (
        <ConfirmDialog
          title={`Deactivate ${confirmDeactivate.name}?`}
          description="They can't sign in at a till or the back office until reactivated. Their past orders and drawers keep their name."
          confirmLabel="Deactivate"
          onCancel={() => setConfirmDeactivate(null)}
          onConfirm={() => {
            const s = confirmDeactivate;
            setConfirmDeactivate(null);
            void act({ action: "deactivate", staffId: s.id });
          }}
        />
      )}

      {confirmReset && (
        <ConfirmDialog
          title={`Reset ${confirmReset.name}'s PIN?`}
          description="Their current PIN stops working and they are signed out everywhere. You'll see the new PIN once."
          confirmLabel="Reset PIN"
          destructive={false}
          onCancel={() => setConfirmReset(null)}
          onConfirm={() => {
            const s = confirmReset;
            setConfirmReset(null);
            void resetPin(s);
          }}
        />
      )}

      {revealed && <PinReveal {...revealed} onDone={() => setRevealed(null)} />}
    </section>
  );
}

function PinReveal({
  name,
  pin,
  onDone,
}: {
  name: string;
  pin: string;
  onDone: () => void;
}) {
  const id = useId();
  return (
    <Dialog onClose={onDone} labelledBy={`${id}-title`} closeOnBackdrop={false}>
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 text-center shadow-xl">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {name}&apos;s new PIN
        </h2>
        <p
          className="my-4 font-mono text-4xl font-bold tracking-[0.3em]"
          aria-label={`PIN ${pin.split("").join(" ")}`}
        >
          {pin}
        </p>
        <p className="text-sm text-muted-foreground">
          Give it to {name} now. It won&apos;t be shown again; if it&apos;s
          lost, reset it.
        </p>
        <Button className="mt-5 h-11 w-full" onClick={onDone}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

function StaffForm({
  staff,
  actor,
  locations,
  busy,
  error,
  onCancel,
  onSave,
}: {
  staff: Staff | null;
  actor: Actor;
  locations: Location[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(staff?.name ?? "");
  const [role, setRole] = useState<MembershipRole>(staff?.role ?? "cashier");
  const [email, setEmail] = useState(staff?.contact_email ?? "");
  const [phone, setPhone] = useState(staff?.contact_phone ?? "");
  const [moduleRoles, setModuleRoles] = useState<StaffModuleRole[]>(
    staff?.module_roles ?? [],
  );
  const [locationIds, setLocationIds] = useState<string[]>(
    staff?.location_ids ?? [],
  );
  const [issuePin, setIssuePin] = useState(true);
  // A manager can't hand out the owner role.
  const roleOptions = ROLES.filter(
    (r) => actor.role === "owner" || r.role !== "owner",
  );

  const field = "mt-1 h-11 w-full rounded-md border bg-background px-3 text-sm";

  return (
    <Dialog onClose={onCancel} labelledBy={`${id}-title`}>
      <form
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border bg-background p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({
            name,
            role,
            email,
            phone,
            moduleRoles,
            locationIds,
            ...(staff ? {} : { issuePin }),
          });
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {staff ? `Edit ${staff.name}` : "Add staff"}
        </h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">
            Name
            <input
              className={field}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Role
            <select
              className={field}
              value={role}
              onChange={(e) => setRole(e.target.value as MembershipRole)}
            >
              {roleOptions.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Email{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
            <input
              type="email"
              className={field}
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Phone{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
            <input
              type="tel"
              className={field}
              maxLength={32}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">
              Other Open Pizza roles
            </legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {MODULE_ROLES.map(({ role: r, label }) => (
                <label
                  key={r}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10"
                >
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={moduleRoles.includes(r)}
                    onChange={(e) =>
                      setModuleRoles((cur) =>
                        e.target.checked
                          ? [...new Set([...cur, r])]
                          : cur.filter((x) => x !== r),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {locations.length > 1 && (
            <fieldset>
              <legend className="text-sm font-medium">
                Works at{" "}
                <span className="font-normal text-muted-foreground">
                  (none ticked = all)
                </span>
              </legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {locations.map((l) => (
                  <label
                    key={l.id}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10"
                  >
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={locationIds.includes(l.id)}
                      onChange={(e) =>
                        setLocationIds((cur) =>
                          e.target.checked
                            ? [...cur, l.id]
                            : cur.filter((x) => x !== l.id),
                        )
                      }
                    />
                    {l.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!staff && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={issuePin}
                onChange={(e) => setIssuePin(e.target.checked)}
              />
              Give them a PIN now (shown once)
            </label>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 px-5"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="h-11 px-5"
            disabled={busy || !name.trim()}
          >
            {busy ? "Saving…" : staff ? "Save" : "Add"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

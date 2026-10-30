/**
 * Active-staff quick-switch state (client).
 *
 * On a shared terminal the device is logged into a location once; the active
 * staff member is then chosen by PIN (verified server-side at /api/terminal/pin)
 * and attributed to placed orders. The active staff is kept in sessionStorage so
 * it survives reloads but clears when the device session ends.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

export interface ActiveStaff {
  id: string;
  tenant_id: string;
  name: string;
  role: string;
  /** Server staff-session id of this switch-in (recorded on queued orders). */
  session_id?: string;
}

const KEY = "pos.activeStaff";

function read(): ActiveStaff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ActiveStaff) : null;
  } catch {
    return null;
  }
}

export function useActiveStaff() {
  const [activeStaff, setActiveStaff] = useState<ActiveStaff | null>(null);

  // Hydrate from sessionStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    setActiveStaff(read());
  }, []);

  const signIn = useCallback((staff: ActiveStaff) => {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(staff));
    } catch {
      // ignore storage failures
    }
    setActiveStaff(staff);
  }, []);

  const signOut = useCallback(() => {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    setActiveStaff(null);
    // Clear the server-side (httpOnly) active-staff binding too.
    void fetch("/api/terminal/pin", { method: "DELETE" }).catch(() => null);
  }, []);

  /** Verify a PIN server-side and, on success, set the active staff. */
  const verifyPin = useCallback(
    async (staffId: string, pin: string): Promise<boolean> => {
      const res = await fetch("/api/terminal/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Name the last known session so the server revokes it even if the
        // cookie was lost (terminal restarted mid-shift).
        body: JSON.stringify({
          staffId,
          pin,
          previousSessionId: read()?.session_id,
        }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { activeStaff: ActiveStaff };
      signIn(data.activeStaff);
      return true;
    },
    [signIn],
  );

  return { activeStaff, signIn, signOut, verifyPin };
}

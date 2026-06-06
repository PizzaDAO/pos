/**
 * Sign-in form (client) — shared by the tenant /login and /platform/login.
 *
 * REAL MODE (Supabase public env present): email MAGIC-LINK is primary
 * (`signInWithOtp` → emailed link → /auth/callback), with optional
 * email/PASSWORD (`signInWithPassword`). On success the page reloads to the
 * post-login destination.
 *
 * SIMULATED MODE (no Supabase env — the zero-env / CI default): there is no real
 * auth, so the form is replaced by a clear notice that the app is running with a
 * simulated demo session, plus a button to continue into the destination.
 */
"use client";

import { useState } from "react";
import {
  getBrowserSupabase,
  isSupabaseAuthConfigured,
} from "@/lib/auth/supabase-browser";

export function SignInForm({
  redirect = "/admin",
  heading = "Sign in",
  subheading,
}: {
  redirect?: string;
  heading?: string;
  subheading?: string;
}) {
  const configured = isSupabaseAuthConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  // ---- SIMULATED MODE ----
  if (!configured) {
    return (
      <main
        id="main-content"
        className="mx-auto mt-24 w-full max-w-sm rounded-lg border p-6 text-center"
      >
        <h1 className="mb-2 text-xl font-semibold">{heading}</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          This deployment is running with <strong>simulated auth</strong> (no
          Supabase configured). You are signed in as the demo account. Set the
          Supabase env vars to enable real login.
        </p>
        <a
          href={redirect}
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Continue
        </a>
      </main>
    );
  }

  const callbackUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/auth/callback?redirect=${encodeURIComponent(redirect)}`;

  async function sendMagicLink() {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    setStatus("sending");
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl },
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      setStatus("sent");
      setMessage("Check your email for a sign-in link.");
    }
  }

  async function signInWithPassword() {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    setStatus("sending");
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      window.location.assign(redirect);
    }
  }

  // ---- REAL MODE ----
  return (
    <main
      id="main-content"
      className="mx-auto mt-24 w-full max-w-sm rounded-lg border p-6"
    >
      <h1 className="mb-1 text-xl font-semibold">{heading}</h1>
      {subheading && (
        <p className="mb-4 text-sm text-muted-foreground">{subheading}</p>
      )}

      <label className="mb-1 block text-sm font-medium">Email</label>
      <input
        type="email"
        autoComplete="email"
        className="mb-3 w-full rounded-md border px-3 py-2"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@pizzeria.com"
      />

      {usePassword && (
        <>
          <label className="mb-1 block text-sm font-medium">Password</label>
          <input
            type="password"
            autoComplete="current-password"
            className="mb-3 w-full rounded-md border px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}

      {message && (
        <p
          className={`mb-3 text-sm ${status === "error" ? "text-red-600" : "text-emerald-600"}`}
        >
          {message}
        </p>
      )}

      <button
        className="mb-2 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={status === "sending" || !email}
        onClick={() =>
          void (usePassword ? signInWithPassword() : sendMagicLink())
        }
      >
        {status === "sending"
          ? "Working…"
          : usePassword
            ? "Sign in"
            : "Email me a sign-in link"}
      </button>

      <button
        className="w-full text-center text-xs text-muted-foreground hover:underline"
        onClick={() => {
          setUsePassword((v) => !v);
          setMessage(null);
          setStatus("idle");
        }}
      >
        {usePassword ? "Use a magic link instead" : "Use a password instead"}
      </button>
    </main>
  );
}

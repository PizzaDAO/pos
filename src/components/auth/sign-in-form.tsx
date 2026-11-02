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

/** Map raw Supabase auth strings to plain copy. */
function friendlyAuthError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("invalid login") || m.includes("invalid credentials"))
    return "That email and password don’t match. Try again or use an email link.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Please wait a minute and try again.";
  if (m.includes("email") && m.includes("invalid"))
    return "Enter a valid email address.";
  if (m.includes("network") || m.includes("fetch"))
    return "Couldn’t reach the server. Check your connection and try again.";
  return "Something went wrong signing you in. Please try again.";
}

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
      setMessage(friendlyAuthError(error.message));
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
      setMessage(friendlyAuthError(error.message));
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

      <label htmlFor="signin-email" className="mb-1 block text-sm font-medium">
        Email
      </label>
      <input
        id="signin-email"
        type="email"
        autoComplete="email"
        className="mb-3 h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@pizzeria.com"
      />

      {usePassword && (
        <>
          <label
            htmlFor="signin-password"
            className="mb-1 block text-sm font-medium"
          >
            Password
          </label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            className="mb-3 h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}

      {message && (
        <p
          role={status === "error" ? "alert" : "status"}
          className={`mb-3 text-sm ${status === "error" ? "text-red-600" : "text-emerald-600"}`}
        >
          {message}
        </p>
      )}

      <button
        className="mb-2 h-11 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
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
        className="min-h-11 w-full text-center text-sm text-muted-foreground hover:underline"
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

/**
 * Sign-out control. POSTs to /auth/signout (clears the Supabase session) and
 * redirects to the given login. A no-op-feeling action in simulated mode (no
 * real session), but always present so the control exists on every surface.
 */
"use client";

export function SignOutButton({
  redirect = "/login",
  className,
  label = "Sign out",
}: {
  redirect?: string;
  className?: string;
  label?: string;
}) {
  return (
    <form action={`/auth/signout?redirect=${encodeURIComponent(redirect)}`} method="post">
      <button
        type="submit"
        className={
          className ??
          "rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-secondary"
        }
      >
        {label}
      </button>
    </form>
  );
}

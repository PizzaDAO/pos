import { SignInForm } from "@/components/auth/sign-in-form";

/**
 * Tenant app login (/admin, /terminal, /kitchen). Email magic-link primary, with
 * optional password. After login, role/tenant are resolved from the session's
 * memberships in each gated route's server guard (a chooser appears at
 * /login/choose when the user belongs to multiple tenants). In simulated mode
 * the form shows a "simulated auth" notice and a Continue button.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const { redirect, error } = await searchParams;
  const dest = redirect && redirect.startsWith("/") ? redirect : "/admin";
  return (
    <SignInForm
      redirect={dest}
      heading="Sign in"
      subheading={
        error === "link_invalid"
          ? "That sign-in link was invalid or expired — request a new one."
          : "Pizzeria staff sign-in."
      }
    />
  );
}

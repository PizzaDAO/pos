import { SignInForm } from "@/components/auth/sign-in-form";

/**
 * Super-admin (/platform) login — gated to platform_admins. The form is the same
 * Supabase magic-link / password sign-in; the platform-admin check happens after
 * login in requirePlatformAdmin (a non-admin who signs in is bounced back here
 * with ?error=forbidden). In simulated mode the seeded platform operator is used.
 */
export const dynamic = "force-dynamic";

export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <SignInForm
      redirect="/platform"
      heading="Platform admin"
      subheading={
        error === "forbidden"
          ? "That account is not a platform admin."
          : "Super-admin access only."
      }
    />
  );
}

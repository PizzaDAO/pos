/**
 * 403 surface — shown when an authenticated user lacks the role for a surface
 * (e.g. a cashier opening /admin). Distinct from signed-out (which redirects to
 * a login). Offers a sign-out so they can switch accounts.
 */
export default function ForbiddenPage() {
  return (
    <main
      id="main-content"
      className="mx-auto mt-24 w-full max-w-md rounded-lg border p-6 text-center"
    >
      <h1 className="mb-2 text-xl font-semibold">No access</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Your account doesn&apos;t have permission for this area. If this is
        wrong, ask your pizzeria owner to update your role.
      </p>
      <form action="/auth/signout?redirect=/login" method="post">
        <button className="rounded-md border px-4 py-2 text-sm">
          Sign out
        </button>
      </form>
    </main>
  );
}

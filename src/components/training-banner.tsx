import { connection } from "next/server";
import { demoModeInfo } from "@/lib/demo/mode";

/**
 * Training-mode badge for the terminal / kitchen / admin chrome (§8).
 *
 * Server-rendered from `demoModeInfo()`; renders nothing when the deployment is
 * taking real orders. `connection()` opts the render into request-time so the
 * env-derived flag is read per request, never frozen at build. Fixed +
 * `pointer-events-none` so it is unmistakable but never blocks a tap.
 */
export async function TrainingBanner() {
  await connection();
  const { banner } = demoModeInfo();
  if (!banner) return null;
  return (
    <div
      role="status"
      data-testid="training-banner"
      className="pointer-events-none fixed inset-x-0 top-0 z-[150] flex justify-center"
    >
      <span className="rounded-b-md bg-amber-400 px-3 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-950 shadow">
        {banner}
      </span>
    </div>
  );
}

import { connection } from "next/server";
import { demoModeInfo } from "@/lib/demo/mode";

/**
 * Training-mode badge for the terminal / kitchen / admin chrome (§8).
 *
 * Server-rendered from `demoModeInfo()`; renders nothing when the deployment is
 * taking real orders. `connection()` opts the render into request-time so the
 * env-derived flag is read per request, never frozen at build. It is an IN-FLOW
 * strip (not fixed) so it never covers header content; the terminal layout
 * reserves its height. A labelled landmark keeps axe's region rule happy.
 */
export async function TrainingBanner() {
  await connection();
  const { banner } = demoModeInfo();
  if (!banner) return null;
  return (
    <aside
      aria-label="Training mode"
      data-testid="training-banner"
      className="shrink-0 bg-amber-400 px-3 py-0.5 text-center text-[11px] font-bold uppercase tracking-wide text-amber-950"
    >
      <p role="status">{banner}</p>
    </aside>
  );
}

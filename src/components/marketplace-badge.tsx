/** Provider badge for marketplace orders (till open-orders list, kitchen ticket). */
import { cn } from "@/lib/utils";
import { providerLabel } from "@/lib/marketplace/types";

const STYLES: Record<string, string> = {
  doordash: "bg-red-600 text-white",
  ubereats: "bg-emerald-700 text-white",
  grubhub: "bg-orange-600 text-white",
  simulator: "bg-slate-600 text-white",
};

export function MarketplaceBadge({
  provider,
  displayId,
  className,
}: {
  provider: string;
  displayId?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        STYLES[provider] ?? "bg-slate-600 text-white",
        className,
      )}
      data-testid="marketplace-badge"
    >
      {providerLabel(provider)}
      {displayId ? ` #${displayId}` : ""}
    </span>
  );
}

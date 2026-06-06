import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Consistent empty-state block (no orders, empty cart, no reports data, etc.).
 * Presentational only: an optional icon, a title, an optional description, and
 * optional action(s). Replaces ad-hoc centered "No items" paragraphs so empty
 * states look the same across surfaces.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <Icon
          className="h-10 w-10 text-muted-foreground/60"
          aria-hidden="true"
        />
      )}
      <p className="text-base font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

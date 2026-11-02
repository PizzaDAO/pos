import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "./register-sw";
import { InstallPrompt } from "./install-prompt";
import { TrainingBanner } from "@/components/training-banner";

export const metadata: Metadata = {
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "POS Terminal",
  },
};

export const viewport: Viewport = {
  themeColor: "#dc2626",
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays enabled (WCAG 1.4.4); double-tap zoom on controls is
  // suppressed with `touch-action: manipulation` in globals.css instead.
};

export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <RegisterServiceWorker />
      {/* Column shell: the in-flow banner takes its height, the terminal (h-full)
          fills the rest, so the full-height POS grid never overflows. */}
      <div className="flex h-screen flex-col">
        <TrainingBanner />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      <InstallPrompt />
    </>
  );
}

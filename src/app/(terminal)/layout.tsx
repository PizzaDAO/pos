import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "./register-sw";

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
  // Prevent accidental pinch-zoom on the terminal during fast order entry.
  maximumScale: 1,
  userScalable: false,
};

export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <RegisterServiceWorker />
      {children}
    </>
  );
}

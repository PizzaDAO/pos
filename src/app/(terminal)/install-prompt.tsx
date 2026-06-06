/**
 * PWA install prompt (terminal). Captures the browser's `beforeinstallprompt`
 * event and surfaces a dismissible "Install" affordance so staff can add the
 * terminal to the home screen. Purely presentational/UX — it triggers the
 * platform's native install flow and changes no app data or behaviour. Renders
 * nothing when the app is already installed or the event isn't available
 * (e.g. iOS Safari, which has no programmatic prompt).
 */
"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferred(null);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred || dismissed) return null;

  return (
    <div
      role="region"
      aria-label="Install app"
      className="fixed bottom-4 left-1/2 z-40 flex w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-background p-3 shadow-lg"
    >
      <Download className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Install the terminal</p>
        <p className="text-xs text-muted-foreground">
          Add it to your home screen for full-screen, offline-ready ordering.
        </p>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          await deferred.prompt();
          await deferred.userChoice;
          setDeferred(null);
        }}
      >
        Install
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dismiss install prompt"
        onClick={() => setDismissed(true)}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

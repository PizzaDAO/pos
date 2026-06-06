"use client";

import { useEffect } from "react";
import { captureError } from "@/lib/observability";

/**
 * Global error boundary — the last resort if the root layout itself throws.
 * Must render its own <html>/<body>. Kept dependency-light (no shared UI that
 * assumes the layout's font/providers). Inline styles here are React style
 * objects, NOT an inline <script>, so the CSP is not affected.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { scope: "app", route: "global" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#fafafa",
          color: "#0a0a0a",
        }}
      >
        <div style={{ textAlign: "center", padding: "1.5rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ color: "#525252", maxWidth: "28rem" }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              borderRadius: "0.375rem",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              padding: "0.5rem 1rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

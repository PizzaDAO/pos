import { PlatformConsole } from "./platform-console";

/**
 * Super-admin platform console (Phase 6). Operates outside tenant RLS (tied to
 * the platform_admins concept): lists every tenant with health (subscription
 * state, # locations, recent order volume), drills into a tenant's billing
 * overview, and offers AUDITED support impersonation ("view as tenant") plus
 * suspend/reactivate — every sensitive action writes an audit-log entry shown
 * here. All data flows through getPosDriver(); no env vars required.
 */
export default function PlatformPage() {
  return <PlatformConsole />;
}

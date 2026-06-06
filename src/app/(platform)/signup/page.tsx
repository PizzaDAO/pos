import type { Metadata } from "next";
import { SignupWizard } from "./signup-wizard";

export const metadata: Metadata = {
  title: "Start your pizzeria",
  description:
    "Self-serve onboarding: create your pizzeria, add a location, connect payouts, import a starter menu, and go live.",
};

/**
 * Self-serve tenant signup + onboarding wizard (Phase 6, public route).
 *
 * A multi-step wizard that creates a brand-new, ISOLATED tenant: (1) business +
 * owner user, (2) first location, (3) Stripe Connect onboarding (reusing the
 * Phase 2 scaffold — real link behind env, simulated "connected" otherwise),
 * (4) starter menu import (reusing the seed as a template), (5) pick a plan
 * (Stripe Billing — simulated when unkeyed), (6) go live. On completion the new
 * tenant's /admin and /shop work in isolation from the demo tenant.
 *
 * Everything runs through getPosDriver(); no env vars are required.
 */
export default function SignupPage() {
  return <SignupWizard />;
}

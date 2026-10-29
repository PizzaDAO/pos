/**
 * When may a SIMULATED payment rail (no live keys) settle a tender?
 *
 * Simulated rails "succeed" without moving money. That is only safe in the
 * zero-env demo (mock driver, no real auth). As soon as the real driver or
 * real auth is active, a missing STRIPE_SECRET_KEY / BASE_RPC_URL / Coinbase key
 * must make that rail UNAVAILABLE — never silently mark orders paid. An
 * explicit ALLOW_SIMULATED_PAYMENTS=true opts in (e.g. a training deployment).
 * Pure; callers pass the current context.
 */
export function simulatedRailsAllowed(input: {
  driverName: string;
  realAuth: boolean;
  allowFlag?: string | null;
}): boolean {
  if (input.allowFlag === "true") return true;
  return input.driverName === "mock" && !input.realAuth;
}

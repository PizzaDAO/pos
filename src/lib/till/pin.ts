/**
 * PIN keypad auto-submit. Staff PINs are 4-8 digits (lib/auth/pin.ts) and the
 * picker doesn't know a person's length, so it submits automatically at 6 digits
 * (the common maximum) and otherwise waits for Enter / the Switch button. When a
 * length is known for the chosen staff member (4-6), it submits exactly there.
 */
export const DEFAULT_PIN_AUTOSUBMIT_LENGTH = 6;

export function shouldAutoSubmitPin(pin: string, knownLength?: number | null): boolean {
  if (!/^[0-9]+$/.test(pin)) return false;
  const target =
    knownLength && knownLength >= 4 && knownLength <= 6
      ? knownLength
      : DEFAULT_PIN_AUTOSUBMIT_LENGTH;
  return pin.length >= target;
}

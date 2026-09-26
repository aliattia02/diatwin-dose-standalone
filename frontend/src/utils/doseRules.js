/**
 * Final dose rules (clinician decision 26 Sep 2026). One definition per language, compared by the parity harness
 * (family `dose_final`): backend/utils/dose_math.py::finalise_dose, mobile/utils/insulin/dose-rules.ts, this file.
 *
 *  - a suggestion below min_dose_units (default 0.5 U) is not given at all: 0 U. This replaces the floor that raised
 *    small doses to 0.5 U even when active insulin already exceeded the need;
 *  - otherwise the dose is rounded DOWN to the device step: 0.5 U for pens (default), 0.1 U for pumps;
 *    dose_step_units overrides.
 * No React, no imports: the parity harness runs this file directly under Node.
 */

export const DELIVERY_STEPS = { pen: 0.5, pump: 0.1 };

export function doseStep(c) {
  const explicit = c?.dose_step_units;
  if (explicit !== undefined && explicit !== null) return Number(explicit);
  return DELIVERY_STEPS[c?.insulin_delivery ?? 'pen'] ?? 0.5;
}

export function minDose(c) {
  const m = c?.min_dose_units;
  return m === undefined || m === null ? 0.5 : Number(m);
}

/** raw = the unrounded dose after every adjustment, already >= 0. */
export function finaliseDose(raw, c) {
  if (raw < minDose(c)) return 0;
  const step = doseStep(c);
  return Math.round(Math.floor(raw / step + 1e-9) * step * 100) / 100;
}

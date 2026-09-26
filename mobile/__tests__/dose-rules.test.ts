/**
 * Final dose rules (clinician decision 26 Sep 2026): utils/insulin/dose-rules.ts.
 * The cross-language agreement with backend dose_math.finalise_dose and web doseRules.js is the parity harness's
 * `dose_final` family; these tests pin the rule itself.
 */
import { doseStep, finaliseDose, minDose } from '../utils/insulin/dose-rules';

describe('finaliseDose', () => {
  it('gives no suggestion below the minimum (default 0.5 U) instead of raising it to 0.5 U', () => {
    expect(finaliseDose(0.49, {})).toBe(0);
    expect(finaliseDose(0.3, { insulin_delivery: 'pump' })).toBe(0);
    expect(finaliseDose(0.5, {})).toBe(0.5);
  });

  it('rounds DOWN to the pen step (0.5 U) by default', () => {
    expect(finaliseDose(1.1, {})).toBe(1);
    expect(finaliseDose(1.49, { insulin_delivery: 'pen' })).toBe(1);
    expect(finaliseDose(2.25, undefined)).toBe(2);
  });

  it('rounds DOWN to the pump step (0.1 U), without float artefacts', () => {
    expect(finaliseDose(1.1, { insulin_delivery: 'pump' })).toBe(1.1);
    expect(finaliseDose(1.19, { insulin_delivery: 'pump' })).toBe(1.1);
    expect(finaliseDose(0.6, { insulin_delivery: 'pump' })).toBe(0.6);
  });

  it('honours explicit dose_step_units and min_dose_units', () => {
    expect(finaliseDose(1.17, { insulin_delivery: 'pump', dose_step_units: 0.05 })).toBe(1.15);
    expect(finaliseDose(0.9, { min_dose_units: 1.0 })).toBe(0);
    expect(finaliseDose(0.2, { insulin_delivery: 'pump', min_dose_units: 0 })).toBe(0.2);
  });

  it('reports the rule it applies', () => {
    expect(doseStep({ insulin_delivery: 'pump' })).toBe(0.1);
    expect(doseStep({})).toBe(0.5);
    expect(minDose(null)).toBe(0.5);
  });
});

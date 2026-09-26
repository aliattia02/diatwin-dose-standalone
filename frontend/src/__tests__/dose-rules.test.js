/**
 * Final dose rules (clinician decision 26 Sep 2026): utils/doseRules.js, used by the meal screen's
 * EnhancedPatientConstantsCalc.calculateInsulinDose. Cross-language agreement with the backend and the mobile client
 * is the parity harness's `dose_final` family; these tests pin the rule and its use in the web calculator.
 */
import { doseStep, finaliseDose, minDose } from '../utils/doseRules';
import { calculateInsulinDose } from '../components/EnhancedPatientConstantsCalc';

describe('finaliseDose', () => {
  it('gives no suggestion below the minimum instead of raising it to 0.5 U', () => {
    expect(finaliseDose(0.49, {})).toBe(0);
    expect(finaliseDose(0.5, {})).toBe(0.5);
  });

  it('rounds DOWN to the pen (0.5 U) or pump (0.1 U) step', () => {
    expect(finaliseDose(1.1, {})).toBe(1);
    expect(finaliseDose(1.1, { insulin_delivery: 'pump' })).toBe(1.1);
    expect(finaliseDose(1.19, { insulin_delivery: 'pump' })).toBe(1.1);
    expect(finaliseDose(1.17, { insulin_delivery: 'pump', dose_step_units: 0.05 })).toBe(1.15);
  });

  it('reports the rule it applies', () => {
    expect(doseStep({ insulin_delivery: 'pump' })).toBe(0.1);
    expect(minDose(undefined)).toBe(0.5);
  });
});

describe('calculateInsulinDose (web meal screen)', () => {
  const constants = { insulin_to_carb_ratio: 10, correction_factor: 40, target_glucose: 100, protein_factor: 0.5,
                      fat_factor: 0.2, carb_to_bg_factor: 4.0, activity_coefficients: {}, absorption_modifiers: {},
                      disease_factors: {}, medication_factors: {}, active_conditions: [], active_medications: [] };

  it('no longer stacks 0.5 U on active insulin that already exceeds the need', async () => {
    const r = await calculateInsulinDose({ carbs: 0, protein: 0, fat: 0, bloodSugar: 115, activities: [],
                                           patientConstants: constants, mealType: 'normal', activeInsulinValue: 2.0 });
    expect(r.breakdown.postActiveTotal).toBeLessThan(0);
    expect(r.total).toBe(0);
  });

  it('rounds a pump user to 0.1 U and a pen user to 0.5 U', async () => {
    const args = { carbs: 23, protein: 0, fat: 0, bloodSugar: 100, activities: [], mealType: 'normal', activeInsulinValue: 0 };
    const pen = await calculateInsulinDose({ ...args, patientConstants: constants });
    const pump = await calculateInsulinDose({ ...args, patientConstants: { ...constants, insulin_delivery: 'pump' } });
    expect(pen.breakdown.rawTotal).toBeCloseTo(2.3, 6);
    expect(pen.total).toBe(2);
    expect(pump.total).toBe(2.3);
    expect(pump.breakdown.doseStepUnits).toBe(0.1);
  });
});

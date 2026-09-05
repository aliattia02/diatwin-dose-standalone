/**
 * D23 — `getAvailableInsulinTypes` reads camelCase keys off snake_case objects.
 *
 * `InsulinPharmacokinetics` (types/insulin.types.ts:169) declares
 * `onset_hours`, `peak_hours`, `duration_hours`, `is_peakless`. The mapper at
 * pharmacodynamics.ts:1368 reads `value.onsetHours`, `value.peakHours`,
 * `value.durationHours`, `value.isPeakless` — four properties that do not
 * exist — and assigns each to the correctly-named output field. Every one is
 * `undefined` at runtime.
 *
 * `tsc --noEmit` names all four, each with the fix in the message:
 *
 *     error TS2551: Property 'onsetHours' does not exist on type
 *         'InsulinPharmacokinetics'. Did you mean 'onset_hours'?
 *
 * It is latent: the only caller is `getInsulinTypesByCategory`, which nothing
 * calls. Latent is not harmless — the function's whole purpose is to feed an
 * insulin-selection UI, and the first screen to use it would render four blank
 * fields for every insulin type, with the type list itself looking correct.
 *
 * These assertions fail against the pre-fix code (each field is `undefined`).
 */

import {
  getAvailableInsulinTypes,
  getInsulinTypesByCategory,
} from '../utils/insulin/pharmacodynamics';

describe('getAvailableInsulinTypes', () => {
  it('returns a non-empty, sorted list of insulin types', () => {
    const types = getAvailableInsulinTypes();

    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => typeof t.id === 'string' && t.id.length > 0)).toBe(true);
    expect(types.every((t) => typeof t.type === 'string' && t.type.length > 0)).toBe(true);
  });

  it('populates every pharmacokinetic field', () => {
    /**
     * The defect. Before the fix each of these four is `undefined` for every
     * insulin type, while `id`, `name`, `displayName` and `type` are correct —
     * which is exactly why it would survive a glance at the rendered list.
     */
    const types = getAvailableInsulinTypes();

    for (const t of types) {
      expect(typeof t.onset_hours).toBe('number');
      expect(typeof t.duration_hours).toBe('number');
      expect(typeof t.is_peakless).toBe('boolean');
      // peak_hours is legitimately absent for peakless insulins.
      if (!t.is_peakless) {
        expect(typeof t.peak_hours).toBe('number');
      }
    }
  });

  it('reports physiologically ordered durations', () => {
    /**
     * A property assertion rather than pinned numbers (Arm 5 rule 11): onset
     * precedes peak precedes duration. This would pass vacuously if the fields
     * were `undefined`, so it is paired with the type checks above rather than
     * standing alone.
     */
    const types = getAvailableInsulinTypes();

    for (const t of types) {
      expect(t.onset_hours).toBeGreaterThanOrEqual(0);
      expect(t.duration_hours).toBeGreaterThan(t.onset_hours);
      if (!t.is_peakless && typeof t.peak_hours === 'number') {
        expect(t.peak_hours).toBeGreaterThanOrEqual(t.onset_hours);
        expect(t.peak_hours).toBeLessThanOrEqual(t.duration_hours);
      }
    }
  });

  it('distinguishes rapid from long acting by duration', () => {
    /**
     * The negative case: the fields must carry *different* values per type, not
     * merely be present. A mapper that filled every row from one profile would
     * satisfy the checks above.
     */
    const byId = new Map(getAvailableInsulinTypes().map((t) => [t.id, t]));
    const durations = [...byId.values()].map((t) => t.duration_hours);

    expect(new Set(durations).size).toBeGreaterThan(1);

    const rapid = [...byId.values()].filter((t) => t.type.startsWith('rapid'));
    const long = [...byId.values()].filter((t) => t.type.startsWith('long'));
    if (rapid.length && long.length) {
      const maxRapid = Math.max(...rapid.map((t) => t.duration_hours));
      const minLong = Math.min(...long.map((t) => t.duration_hours));
      expect(maxRapid).toBeLessThan(minLong);
    }
  });
});

describe('getInsulinTypesByCategory', () => {
  it('groups without losing or inventing entries', () => {
    const flat = getAvailableInsulinTypes();
    const grouped = getInsulinTypesByCategory();

    const total = Object.values(grouped).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(flat.length);
    expect(Object.keys(grouped).length).toBeGreaterThan(1);
  });

  it('carries the pharmacokinetics through the grouping', () => {
    const grouped = getInsulinTypesByCategory();

    for (const list of Object.values(grouped)) {
      for (const t of list) {
        expect(typeof t.onset_hours).toBe('number');
        expect(typeof t.duration_hours).toBe('number');
      }
    }
  });
});

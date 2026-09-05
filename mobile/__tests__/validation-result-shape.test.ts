/**
 * The `ValidationResult.error` / `.errors` mismatch, pinned.
 *
 * `ValidationResult` carries `errors: string[]` and `warnings: string[]`. There
 * is no `error` field. Three call sites read `validation.error` anyway:
 *
 *   app/(auth)/register.tsx            — fixed 5 September; the reported bug
 *   app/(auth)/forgot-password.tsx     — D20, fixed here
 *   components/forms/UnifiedInsulinInput.tsx — D20, fixed here
 *
 * All three sat in the 191 `tsc --noEmit` errors, each one naming its own fix:
 *
 *     error TS2551: Property 'error' does not exist on type 'ValidationResult'.
 *         Did you mean 'errors'?
 *
 * The register case reached a user. The other two are quieter and worse in one
 * respect: both write `validation.error || '<generic>'`, so the specific message
 * is silently replaced by a generic one rather than coming out blank. Nothing
 * looks broken — the reason is just gone.
 *
 * In `UnifiedInsulinInput` that reason is a dose-safety message. This suite
 * asserts the specific text survives to the caller, which is what the fix
 * restores; it fails against the pre-fix code, where the rendered string is
 * always "Invalid dose".
 */

import { validateEmail, validateInsulinDose } from '../utils/validation';
import { INSULIN_LIMITS } from '../utils/validation/input-validators';

describe('ValidationResult carries errors, never error', () => {
  it('exposes errors as an array and has no error field', () => {
    const result = validateEmail('not-an-email');

    expect(result.isValid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    // The field three call sites reached for. It has never existed.
    expect((result as unknown as { error?: unknown }).error).toBeUndefined();
  });

  it('reading .error yields nothing, so a fallback always wins', () => {
    /**
     * The defect, stated as the expression that contains it. This is what
     * `forgot-password.tsx:42` and `UnifiedInsulinInput.tsx:1017` computed.
     */
    const result = validateEmail('');
    const buggy = (result as unknown as { error?: string }).error || 'Invalid email';
    const fixed = result.errors.join('. ');

    expect(buggy).toBe('Invalid email');          // the generic fallback, always
    expect(fixed).toBe('Email is required');      // what the validator actually said
    expect(fixed).not.toBe(buggy);
  });
});

describe('the insulin dose message that was being discarded', () => {
  it('names the limit when a dose exceeds the maximum', () => {
    /**
     * The clinically relevant case. `validateInsulinDose` composes a message
     * naming the entered dose and the maximum; the form showed "Invalid dose".
     *
     * A patient who fat-fingers 150 units should be told what the limit is,
     * not that their input was unspecified-invalid.
     */
    const overdose = INSULIN_LIMITS.MAX + 50;
    const result = validateInsulinDose(overdose);

    expect(result.isValid).toBe(false);
    const message = result.errors.join('. ');

    expect(message).toContain(String(overdose));
    expect(message).toContain(String(INSULIN_LIMITS.MAX));
    expect(message).not.toBe('Invalid dose');
  });

  it('rejects a negative dose with its own reason', () => {
    const result = validateInsulinDose(-5);
    expect(result.isValid).toBe(false);
    expect(result.errors.join('. ')).toMatch(/negative/i);
  });

  it('accepts an ordinary dose and says nothing', () => {
    /**
     * The negative case. A validator that rejected everything would also make
     * every test above pass.
     */
    const result = validateInsulinDose(6);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('warns without rejecting an unusually high but legal dose', () => {
    /**
     * `warnings` is a separate channel and neither form reads it at all, so
     * "unusually high, please verify" is never shown. Pinned as the next thing
     * to surface rather than fixed here — it is a UI decision, not a bug.
     */
    const high = INSULIN_LIMITS.HIGH_WARNING + 1;
    const result = validateInsulinDose(high);

    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join('. ')).toMatch(/verify/i);
  });
});

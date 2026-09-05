/**
 * Password policy.
 *
 * The client is the *only* gate: `register()` in
 * `backend/routes/auth_routes.py` hashes whatever it is sent and applies no
 * strength rule of its own. So this file is where the policy actually lives,
 * and a change to it should be deliberate rather than incidental.
 *
 * The policy is currently **relaxed for the testing phase**. These tests pin
 * that state on purpose (Arm 5 rule 13: a test that characterizes current
 * behaviour says so and names what it pins). When the production policy is
 * restored, the two tests marked PINS RELAXED-POLICY are the ones to update —
 * they are written so that tightening the rule fails loudly instead of passing
 * quietly.
 *
 * The blank-error bug these were written alongside is covered too: it was not
 * that validation rejected a password, but that the screen displayed nothing
 * when it did, because `ValidationResult` carries `errors: string[]` and the
 * register screen read `.error`. An empty message is worse than a strict rule.
 */

import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIRE_LETTER_AND_NUMBER,
  validatePassword,
} from '../utils/validation';

describe('password policy', () => {
  it('PINS RELAXED-POLICY: the testing-phase constants', () => {
    // Restore to 8 / true for production and update this test with it.
    expect(PASSWORD_MIN_LENGTH).toBe(6);
    expect(PASSWORD_REQUIRE_LETTER_AND_NUMBER).toBe(false);
  });

  it('accepts a password at exactly the minimum length', () => {
    const result = validatePassword('a'.repeat(PASSWORD_MIN_LENGTH));
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects one character below the minimum', () => {
    // The boundary in both directions, so an off-by-one cannot pass.
    const result = validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(result.isValid).toBe(false);
  });

  it('rejects an empty password', () => {
    const result = validatePassword('');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Password is required');
  });

  it('PINS RELAXED-POLICY: letters-only is accepted while the rule is off', () => {
    // 'asdfasdf' was refused under the old rule, and the register screen showed
    // a blank message when it did. It is accepted now.
    const result = validatePassword('asdfasdf');
    expect(result.isValid).toBe(true);
  });

  it('warns about a short password without blocking it', () => {
    // A warning surfaces the risk without stopping a test account. It has to
    // be a warning and not an error, or the relaxation achieves nothing.
    const result = validatePassword('test12');
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not warn about a password that would pass the production policy', () => {
    const result = validatePassword('asdfasdf1');
    expect(result.isValid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('every rejection carries a message', () => {
  // The actual defect behind "no actions on signup": validation refused the
  // form and the screen rendered an empty string, because the result type has
  // `errors` (array) and the caller read `error` (singular, nonexistent). A
  // rejection with nothing to display is indistinguishable from a dead button.
  it.each([
    ['', 'empty'],
    ['a', 'one character'],
    ['abc', 'below the minimum'],
  ])('rejecting %j (%s) produces a non-empty message', (password) => {
    const result = validatePassword(password as string);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const message of result.errors) {
      expect(message.trim()).not.toBe('');
    }
  });

  it('the result type exposes errors as an array, not a single error', () => {
    // Guards the exact shape the register screen got wrong. If someone
    // reintroduces a singular `error`, this says so.
    const result = validatePassword('');
    expect(Array.isArray(result.errors)).toBe(true);
    expect((result as unknown as { error?: string }).error).toBeUndefined();
  });
});

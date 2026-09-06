/**
 * D28 — `ActivityVisualization` accepted `isDoctor`/`patientId` from the
 * doctor dashboard and used neither.
 *
 * Two independent failures, both silent:
 *
 * 1. `fetchActivities` always requested `/api/activity-history` — the
 *    CALLER's own activities. In doctor mode the caller is the doctor, so a
 *    doctor viewing a patient's "Activities" tab saw either the doctor's own
 *    (typically empty) history, or nothing, rendered under that patient's
 *    name and header.
 *
 * 2. Every PD calculation in the file (`calculateActivityCumulativeEffect`,
 *    `getActivityOnBoard`, the reset-hour boundary, HR base/max for intensity
 *    zones) read `patientConstants` from `useConstants()` — the DOCTOR's own
 *    constants, never the selected patient's. Even once (1) is fixed, the
 *    resulting effect curves would be computed with the wrong correction
 *    factor, the wrong HR zones and the wrong daily-reset boundary.
 *
 * `/api/doctor/patient/<id>/activity-history` (the sibling doctor endpoint)
 * is deliberately NOT the fix here: it returns `activityType`/`activityLevel`,
 * a shape `normalizeActivityRecord` cannot read at all — every record from it
 * would map to `null` and vanish. `/api/patient/<id>/activity-history`
 * (`backend/activity.py`, its authorization gap closed as D27 in the same
 * session) returns the matching PD shape, so that is the one now used.
 *
 * This suite is deliberately built around axios call assertions rather than
 * a full render, because `ActivityVisualization` sits inside three separate
 * contexts (`ConstantsProvider`, `BloodSugarDataProvider`, `TimeProvider`)
 * that each fetch independently on mount — asserting on the specific calls
 * this component makes is the stable, low-noise way to pin its own behaviour
 * without also pinning theirs.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import axios from 'axios';
import ActivityVisualization from '../components/ActivityVisualization';
import { ConstantsProvider } from '../contexts/ConstantsContext';
import { BloodSugarDataProvider } from '../contexts/BloodSugarDataContext';
import { TimeProvider } from '../contexts/TimeContext';

jest.mock('axios');

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'test-token');
});

/** Every provider ActivityVisualization needs a context for, wrapped once. */
function renderWithProviders(props) {
  return render(
    <TimeProvider>
      <ConstantsProvider>
        <BloodSugarDataProvider>
          <ActivityVisualization {...props} />
        </BloodSugarDataProvider>
      </ConstantsProvider>
    </TimeProvider>,
  );
}

const DOCTOR_CONSTANTS = {
  daily_reset_hour: 9,
  timezone_offset_minutes: 330,
  hr_base: 65,
  hr_max: 190,
};

/**
 * A generic router standing in for the whole backend: anything not
 * specifically asserted on here gets a harmless empty response so the three
 * providers' own mount-time fetches do not throw.
 */
function mockApi({ patientId } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.includes(`/api/doctor/patient/${patientId}/constants`)) {
      return Promise.resolve({ data: { constants: DOCTOR_CONSTANTS } });
    }
    if (url.includes(`/api/patient/${patientId}/activity-history`)) {
      return Promise.resolve({ data: [] });
    }
    if (url.includes('/api/activity-history')) {
      return Promise.resolve({ data: [] });
    }
    if (url.includes('/api/patient/constants')) {
      return Promise.resolve({ data: { constants: {} } });
    }
    return Promise.resolve({ data: [] });
  });
}

describe('the activity fetch targets the selected patient, not the caller', () => {
  it('requests the patient-scoped route in doctor mode', async () => {
    mockApi({ patientId: 'patient-42' });
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });

    await waitFor(() => {
      const urls = axios.get.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.includes('/api/patient/patient-42/activity-history'))).toBe(true);
    });

    // The regression this guards directly: the caller's-own-history route
    // must never be hit once a patient is selected in doctor mode.
    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls).not.toEqual(expect.arrayContaining([expect.stringMatching(/\/api\/activity-history(?!\/)/)]));
  });

  it('never calls the doctor sibling endpoint with the incompatible shape', async () => {
    // /api/doctor/patient/<id>/activity-history returns activityType/
    // activityLevel, which normalizeActivityRecord cannot read — using it
    // would silently empty every chart. Pinned as a negative to catch anyone
    // "fixing" this by reaching for the more obviously-named endpoint.
    mockApi({ patientId: 'patient-42' });
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/doctor/patient/patient-42/activity-history'))).toBe(false);
  });

  it('requests the caller-scoped route in patient mode, unchanged', async () => {
    mockApi({});
    renderWithProviders({ isDoctor: false });

    await waitFor(() => {
      const urls = axios.get.mock.calls.map(([u]) => u);
      expect(urls.some((u) => /\/api\/activity-history(\?|$)/.test(u))).toBe(true);
    });

    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/api/patient/') && u.includes('/activity-history'))).toBe(false);
  });

  it('does nothing patient-specific when isDoctor is set but no patient is selected yet', async () => {
    // The doctor dashboard's "select a patient" placeholder state — isDoctor
    // true, patientId null. Must not crash and must not call a URL with a
    // literal "null" or "undefined" patient segment.
    mockApi({});
    renderWithProviders({ isDoctor: true, patientId: null });

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/undefined/') || u.includes('/null/'))).toBe(false);
  });
});

describe('the patient constants used for PD math come from the selected patient', () => {
  it('fetches /api/doctor/patient/<id>/constants when in doctor mode', async () => {
    mockApi({ patientId: 'patient-42' });
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });

    await waitFor(() => {
      const urls = axios.get.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.includes('/api/doctor/patient/patient-42/constants'))).toBe(true);
    });
  });

  it('does not fetch doctor-scoped constants in patient mode', async () => {
    mockApi({});
    renderWithProviders({ isDoctor: false });

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/api/doctor/patient/'))).toBe(false);
  });
});

/**
 * D28 (continued) — `BloodSugarVisualization` in doctor mode.
 *
 * Every data field this component renders — `combinedData`, `targetGlucose`,
 * `activeEffects`, `recentMealsData`, `recentInsulinData`, `last24hData`,
 * `adjustedBaselineForProjection` — comes from `BloodSugarDataContext`, which
 * is scoped to whoever is logged in. It accepted `isDoctor`/`patientId` props
 * from the doctor dashboard and used neither, so a doctor viewing a selected
 * patient's chart silently saw the DOCTOR's own glucose context (typically
 * empty) rendered under that patient's name.
 *
 * Fully re-scoping this component to a selected patient means
 * re-implementing a large share of a 2,400-line context and is out of scope
 * for this pass. The fix here is the narrower, honest one already applied to
 * D25: an explicit "not yet available" state rather than a silently wrong
 * chart. This suite exists to keep that decision from quietly regressing back
 * into rendering the shared context's data under a patient's header.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import axios from 'axios';
import BloodSugarVisualization from '../components/BloodSugarVisualization';
import { ConstantsProvider } from '../contexts/ConstantsContext';
import { BloodSugarDataProvider } from '../contexts/BloodSugarDataContext';
import { TimeProvider } from '../contexts/TimeContext';

jest.mock('axios');

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'test-token');
  axios.get.mockResolvedValue({ data: [] });
});

function renderWithProviders(props) {
  return render(
    <TimeProvider>
      <ConstantsProvider>
        <BloodSugarDataProvider>
          <BloodSugarVisualization {...props} />
        </BloodSugarDataProvider>
      </ConstantsProvider>
    </TimeProvider>,
  );
}

describe('doctor mode shows an honest gap instead of the wrong patient\'s data', () => {
  it('does not render the chart chrome when isDoctor and a patient are both set', () => {
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });
    expect(screen.getByText(/not yet available in doctor view/i)).toBeInTheDocument();
  });

  it('points the reader at the chart that does work for doctors', () => {
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });
    expect(screen.getByText(/blood sugar chart above/i)).toBeInTheDocument();
  });

  it('never fetches any per-patient blood sugar data in this state', () => {
    // Nothing about a patient's identity should leave the browser from this
    // component while it has nothing correct to show.
    renderWithProviders({ isDoctor: true, patientId: 'patient-42' });
    const urls = axios.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('patient-42'))).toBe(false);
  });
});

describe('patient mode is unaffected', () => {
  it('does not show the doctor-mode placeholder for a patient viewing their own data', async () => {
    renderWithProviders({ isDoctor: false });
    expect(screen.queryByText(/not yet available in doctor view/i)).not.toBeInTheDocument();
  });

  it('renders normally when isDoctor is true but no patient is selected', () => {
    // Mirrors the doctor dashboard's own "select a patient" placeholder
    // state — isDoctor alone must not trigger the gap message.
    renderWithProviders({ isDoctor: true, patientId: null });
    expect(screen.queryByText(/not yet available in doctor view/i)).not.toBeInTheDocument();
  });
});

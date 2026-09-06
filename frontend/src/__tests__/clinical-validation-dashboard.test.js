/**
 * The tab that used to throw now renders, and says what it is showing.
 *
 * `ClinicalValidationDashboard.js` was 0 bytes and was still imported and
 * rendered as a named tab (D25). Proving the file is no longer empty is the
 * `dashboard-tabs` suite's job; this one renders it, which is the thing a
 * clinician actually does.
 *
 * The assertions lean on the parts of the contract that are easy to break
 * silently: that a missing decision is not shown as a zero, that the sign of a
 * disagreement survives to the screen, and that the surface names what produced
 * its numbers. A view can be badly wrong on all three and still look fine.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import ClinicalValidationDashboard from '../components/ClinicalValidationDashboard';
import InsulinDisagreementView from '../components/InsulinDisagreementView';

jest.mock('axios');

const HOUR = 3_600_000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

const meal = (over) => ({
  id: 'm1',
  mealType: 'lunch',
  timestamp: ago(2),
  suggestedInsulin: 5,
  intendedInsulin: 5,
  nutrition: { carbs: 50 },
  ...over,
});

/** Route each URL to its own payload, the way the real endpoints answer. */
function mockApi({ meals = [], constants = {} } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.includes('/constants')) {
      return Promise.resolve({ data: { constants } });
    }
    return Promise.resolve({ data: { meals, pagination: { total: meals.length } } });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'test-token');
});

describe('the dashboard renders instead of throwing', () => {
  it('mounts and shows its heading', async () => {
    mockApi({ meals: [meal()] });
    render(<ClinicalValidationDashboard />);
    expect(await screen.findByText(/Clinical validation/i)).toBeInTheDocument();
  });

  it('names the producer of its numbers', async () => {
    // Contract rule 2. A surface that shows a suggestion without saying what
    // computed it cannot be reviewed, and this one must not imply a model.
    mockApi({ meals: [meal()] });
    render(<ClinicalValidationDashboard />);
    await waitFor(() =>
      expect(screen.getByText(/rules:meal_insulin/)).toBeInTheDocument());
  });
});

describe('the disagreement view reports what it found', () => {
  it('counts the decisions it could compare', async () => {
    mockApi({
      meals: [
        meal({ id: 'a', suggestedInsulin: 4, intendedInsulin: 6 }),
        meal({ id: 'b', suggestedInsulin: 6, intendedInsulin: 4 }),
        meal({ id: 'c', suggestedInsulin: 5, intendedInsulin: 5 }),
      ],
    });
    render(<InsulinDisagreementView />);
    await waitFor(() =>
      expect(screen.getByText('decisions compared')).toBeInTheDocument());
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows a signed difference, not a magnitude', async () => {
    // Two meals, both 2 U over. The median must render as +2.00 and not 2.00 —
    // the sign is the clinical reading.
    mockApi({
      meals: [
        meal({ id: 'a', suggestedInsulin: 4, intendedInsulin: 6 }),
        meal({ id: 'b', suggestedInsulin: 4, intendedInsulin: 6 }),
      ],
    });
    render(<InsulinDisagreementView />);
    await waitFor(() =>
      expect(screen.getByText('median difference (U)')).toBeInTheDocument());
    expect(screen.getAllByText('+2.00').length).toBeGreaterThan(0);
  });

  it('says there is nothing to compare rather than showing a zero', async () => {
    // The failure this guards: a meal with no recorded dose being read as
    // "took 0 U", which renders as a large negative override that never
    // happened. It must be reported as absent instead.
    mockApi({ meals: [meal({ intendedInsulin: null })] });
    render(<InsulinDisagreementView />);
    await waitFor(() =>
      expect(screen.getByText(/nothing to compare/i)).toBeInTheDocument());
    expect(screen.getByText(/suggested but not acted on/i)).toBeInTheDocument();
  });

  it('reports a dose taken with no suggestion separately', async () => {
    mockApi({ meals: [meal({ suggestedInsulin: null, intendedInsulin: 6 })] });
    render(<InsulinDisagreementView />);
    await waitFor(() =>
      expect(screen.getByText(/dosed without a suggestion/i)).toBeInTheDocument());
  });

  it('surfaces a load failure rather than rendering an empty chart', async () => {
    // An empty chart and a failed request look identical to a clinician.
    axios.get.mockRejectedValue(new Error('network down'));
    render(<InsulinDisagreementView />);
    await waitFor(() =>
      expect(screen.getByText(/Could not load insulin decisions/i)).toBeInTheDocument());
  });
});

describe('timestamps are rendered in the patient timezone', () => {
  it('says which clock it is using when the offset is known', async () => {
    mockApi({
      meals: [meal({ suggestedInsulin: 4, intendedInsulin: 6 })],
      constants: { timezone_offset_minutes: 330, daily_reset_hour: 7 },
    });
    render(<InsulinDisagreementView patientId="p1" isDoctor={true} />);
    await waitFor(() =>
      expect(screen.getByText(/patient's timezone \(UTC\+05:30\)/)).toBeInTheDocument());
  });

  it('falls back to the browser and says so when the offset is absent', async () => {
    // A client talking to a backend that predates the field must degrade to the
    // old behaviour and be honest about it, not silently claim patient time.
    mockApi({
      meals: [meal({ suggestedInsulin: 4, intendedInsulin: 6 })],
      constants: { daily_reset_hour: 7 },
    });
    render(<InsulinDisagreementView patientId="p1" isDoctor={true} />);
    await waitFor(() =>
      expect(screen.getByText(/this browser's timezone/)).toBeInTheDocument());
  });
});

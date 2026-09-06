/**
 * D26 — `BloodSugarChart`'s doctor-mode URL was missing the `/api` prefix.
 *
 * `fetchData` built two URLs: the patient's own request correctly targeted
 * `${API_BASE_URL}/api/blood-sugar`, but the doctor-mode branch built
 * `${API_BASE_URL}/doctor/patient/${patientId}/blood-sugar` — no `/api`. Every
 * backend route in this system is registered under `/api/*`
 * (`backend/routes/doctor_routes.py:434` registers
 * `/api/doctor/patient/<patient_id>/blood-sugar`), so the doctor-mode request
 * always 404'd. `BloodSugarChart` is rendered directly in the doctor
 * dashboard's "additional charts" row — one of the very few doctor-facing
 * charts the frontend parity audit found, and it never worked.
 *
 * Because the failure lands inside a try/catch that only sets a generic
 * "Failed to fetch blood sugar data" error string, this was invisible in the
 * UI's happy-path appearance: the chart renders an empty/error state that
 * looks like "this patient has no data" rather than "this request is
 * malformed".
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import BloodSugarChart from '../components/BloodSugarChart';

jest.mock('axios');

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'test-token');
});

describe('the doctor-mode request targets a real, registered route', () => {
  it('requests /api/doctor/patient/<id>/blood-sugar, not /doctor/patient/<id>/blood-sugar', async () => {
    axios.get.mockResolvedValue({ data: [] });
    render(<BloodSugarChart isDoctor={true} patientId="patient-123" />);

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const [calledUrl] = axios.get.mock.calls[0];

    // The exact regression: a URL with the doctor path but no /api segment
    // matches nothing this backend registers and 404s silently.
    expect(calledUrl).toContain('/api/doctor/patient/patient-123/blood-sugar');
    expect(calledUrl).not.toMatch(/^https?:\/\/[^/]+\/doctor\//);
  });

  it('leaves the patient-mode request untouched', async () => {
    axios.get.mockResolvedValue({ data: [] });
    render(<BloodSugarChart isDoctor={false} />);

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const [calledUrl] = axios.get.mock.calls[0];
    expect(calledUrl).toContain('/api/blood-sugar');
    expect(calledUrl).not.toContain('/doctor/');
  });
});

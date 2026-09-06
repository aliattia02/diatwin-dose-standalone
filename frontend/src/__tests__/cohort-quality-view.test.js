/**
 * `CohortQualityView` end to end against a mocked API — the list endpoint,
 * then the manifest endpoint for whichever snapshot is selected.
 *
 * The two states worth failing loudly on are the two this view was built to
 * surface: an admin who cannot see it (a real access boundary, not a bug to
 * hide) and a stream with nothing fetched (the pre-ML audit's actual finding).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import CohortQualityView from '../components/CohortQualityView';

jest.mock('axios');

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('token', 'test-token');
});

const streamReport = (over) => ({
  collection: 'x', fetched: 100, kept: 100, dropped_normalize: 0, dropped_window: 0,
  ...over,
});

const manifest = (over) => ({
  snapshot_id: 'snap-1',
  content_hash: 'abcdef123456',
  created_at: '2026-03-01T00:00:00Z',
  patients: 1,
  span: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
  load_reports: [{
    patient_id: 'p1',
    profile_found: true,
    insulin_deduped: 0,
    streams: {
      glucose: streamReport(),
      insulin: streamReport(),
      meals: streamReport(),
      activity: streamReport(),
    },
  }],
  leakage_note: 'note',
  ...over,
});

function mockApi({ snapshots = [{ snapshot_id: 'snap-1', patients: 1 }], manifestBody } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manifest')) {
      return Promise.resolve({ data: { manifest: manifestBody ?? manifest() } });
    }
    return Promise.resolve({ data: { snapshots } });
  });
}

describe('the empty and forbidden states are honest', () => {
  it('says no snapshot exists rather than showing a fabricated table', async () => {
    mockApi({ snapshots: [] });
    render(<CohortQualityView />);
    expect(await screen.findByText(/No snapshot has been exported yet/i)).toBeInTheDocument();
  });

  it('shows a 403 as a permissions message, not a generic error', async () => {
    axios.get.mockRejectedValue({ response: { status: 403 } });
    render(<CohortQualityView />);
    expect(await screen.findByText(/admin accounts only/i)).toBeInTheDocument();
  });

  it('surfaces a genuine load failure distinctly from both of the above', async () => {
    axios.get.mockRejectedValue({ response: { status: 500 }, message: 'boom' });
    render(<CohortQualityView />);
    expect(await screen.findByText(/Could not load snapshots/i)).toBeInTheDocument();
  });
});

describe('the audit finding is not buried', () => {
  it('flags a stream with zero rows fetched ahead of the totals table', async () => {
    mockApi({
      manifestBody: manifest({
        load_reports: [{
          patient_id: 'p1',
          profile_found: true,
          insulin_deduped: 0,
          streams: {
            glucose: streamReport({ fetched: 0, kept: 0 }),
            insulin: streamReport(),
            meals: streamReport(),
            activity: streamReport(),
          },
        }],
      }),
    });
    render(<CohortQualityView />);
    expect(await screen.findByText(/zero rows fetched/i)).toBeInTheDocument();
    expect(screen.getByText(/no glucose rows were fetched/i)).toBeInTheDocument();
  });

  it('does not raise the warning for a clean, fully-fetched cohort', async () => {
    mockApi();
    render(<CohortQualityView />);
    await waitFor(() => expect(screen.getByText(/Cohort totals by stream/i)).toBeInTheDocument());
    expect(screen.queryByText(/zero rows fetched/i)).not.toBeInTheDocument();
  });

  it('warns on a large insulin load with nothing deduped', async () => {
    mockApi({
      manifestBody: manifest({
        load_reports: [{
          patient_id: 'p1',
          profile_found: true,
          insulin_deduped: 0,
          streams: {
            glucose: streamReport(),
            insulin: streamReport({ fetched: 5000, kept: 5000 }),
            meals: streamReport(),
            activity: streamReport(),
          },
        }],
      }),
    });
    render(<CohortQualityView />);
    expect(await screen.findByText(/rule 8/i)).toBeInTheDocument();
  });
});

describe('the view names its data', () => {
  it('shows the snapshot id and content hash in the footer', async () => {
    mockApi();
    render(<CohortQualityView />);
    const footerLabel = await screen.findByText(/snapshot:/i);
    const footer = footerLabel.closest('footer');
    // Scoped to the footer: the same id also appears in the snapshot <select>,
    // which is a different fact (what can be chosen) from this one (what was
    // used to produce the numbers on screen).
    expect(footer).toHaveTextContent('snap-1');
    expect(footer).toHaveTextContent('abcdef123456');
  });

  it('surfaces a patient with no constants profile', async () => {
    mockApi({
      manifestBody: manifest({
        load_reports: [{
          patient_id: 'p1',
          profile_found: false,
          insulin_deduped: 0,
          streams: {
            glucose: streamReport(), insulin: streamReport(), meals: streamReport(), activity: streamReport(),
          },
        }],
      }),
    });
    render(<CohortQualityView />);
    await waitFor(() => expect(screen.getByText('missing')).toBeInTheDocument());
  });
});

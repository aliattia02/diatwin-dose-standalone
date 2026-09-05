import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import BloodSugarChart from './BloodSugarChart';
import BloodSugarVisualization from './BloodSugarVisualization';
import MealHistory from './MealHistory';
import EnhancedPatientConstantsUI from './EnhancedPatientConstantsUI';
import ActivityVisualization from './ActivityVisualization';
import GlycemicResponseTracker from './GlycemicResponseTracker';
import DataImport from './ImportExport';
import './Charts/dashboard-components.css';
import { FaSync, FaUserMd, FaClock, FaInfoCircle } from 'react-icons/fa';

import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const DoctorDashboard = ({ handleLogout }) => {
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState({ patients: false, data: false });
  const [errors, setErrors] = useState({ patients: '', data: '' });
  const [errorMessage, setErrorMessage] = useState('');
  const [timeRange, setTimeRange] = useState('7d');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState('meals');
  const [currentTime, setCurrentTime] = useState(new Date());

  const fetchPatients = useCallback(async () => {
    setLoading(prevLoading => ({ ...prevLoading, patients: true }));
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/doctor/patients`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const formattedPatients = response.data.map(patient => ({
        id: patient.id,
        name: `${patient.firstName} ${patient. lastName}`,
        email: patient.email
      }));

      setPatients(formattedPatients);
      setErrors(prevErrors => ({ ...prevErrors, patients: '' }));
    } catch (error) {
      console.error('Error fetching patients:', error);
      const message = error.response?.data?.message || 'Failed to fetch patients';
      setErrors(prevErrors => ({ ...prevErrors, patients: message }));
      setErrorMessage(message);
    } finally {
      setLoading(prevLoading => ({ ...prevLoading, patients: false }));
    }
  }, []);

  useEffect(() => {
    fetchPatients();

    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, [fetchPatients]);

  const handleImportComplete = async (result) => {
    if (result.success) {
      setRefreshTrigger(prev => prev + 1);
      await fetchPatients();
      setErrorMessage(`Successfully imported ${result.count} records`);
      setTimeout(() => setErrorMessage(''), 3000);
    }
  };

  const handleRefreshData = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
    setErrorMessage('Data refreshed');
    setTimeout(() => setErrorMessage(''), 2000);
  }, []);

  const filteredPatients = patients.filter(patient =>
    patient.name.toLowerCase(). includes(searchTerm.toLowerCase())
  );

  const renderPatientSearch = () => (
    <div className="dash-doctor-patient-search-container">
      <input
        type="text"
        className="dash-doctor-patient-search-input"
        placeholder="Search patient name..."
        value={searchTerm}
        onChange={(e) => {
          setSearchTerm(e.target.value);
          setShowResults(true);
        }}
        onFocus={() => setShowResults(true)}
        onBlur={() => {
          setTimeout(() => setShowResults(false), 200);
        }}
      />
      {showResults && (
        <div className="dash-doctor-patient-search-results">
          {filteredPatients. length > 0 ? (
            filteredPatients.map(patient => (
              <div
                key={patient.id}
                className={`dash-doctor-patient-search-item ${
                  selectedPatient?. id === patient.id ? 'dash-doctor-selected' : ''
                }`}
                onClick={() => {
                  setSelectedPatient(patient);
                  setSearchTerm(patient.name);
                  setShowResults(false);
                }}
              >
                <div className="dash-doctor-patient-search-item-content">
                  <span className="dash-doctor-patient-name">{patient.name}</span>
                  <span className="dash-doctor-patient-email">{patient.email}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="dash-doctor-no-results">No patients found</div>
          )}
        </div>
      )}
    </div>
  );

  const renderNoAuthorizedPatients = () => (
    <div className="dash-doctor-no-authorized-patients">
      <FaInfoCircle style={{ fontSize: '48px', color: '#ff9800', marginBottom: '16px' }} />
      <h3>No Authorized Patients Yet</h3>
      <p>
        You don't have any patients who have authorized you to view their data yet.
        Patients must grant you access from their dashboard before you can view their health information.
      </p>
      <p style={{ marginTop: '16px', fontSize: '13px' }}>
        Ask your patients to go to "Manage My Doctors" in their dashboard and authorize your account.
      </p>
    </div>
  );

  return (
    <div className="dash-doctor-dashboard">
      <div className="dash-doctor-header">
        <div className="dash-doctor-header-left">
          <FaUserMd className="dash-doctor-header-icon" />
          <h1>Doctor Dashboard</h1>
          <div className="dash-doctor-header-time">
            <FaClock className="dash-doctor-clock-icon" />
            <span>{currentTime.toLocaleString('en-US', {
              timeZone: 'UTC',
              dateStyle: 'medium',
              timeStyle: 'short'
            })}</span>
          </div>
        </div>
        <button onClick={handleLogout} className="dash-doctor-logout-button">Logout</button>
      </div>

      {errorMessage && (
        <div className={`dash-doctor-message-banner ${errorMessage.includes('Error') ? 'dash-doctor-error' : 'dash-doctor-success'}`}>
          {errorMessage}
          <button onClick={() => setErrorMessage('')} className="dash-doctor-close-message">×</button>
        </div>
      )}

      <div className="dash-doctor-dashboard-container">
        <div className="dash-doctor-sidebar">
          <div className="dash-doctor-patient-list-header">
            <h2>My Patients</h2>
            <span className="dash-doctor-patient-count">
              Authorized: {patients.length}
            </span>
          </div>
          {loading.patients ?  (
            <div className="dash-doctor-loading">Loading patients...</div>
          ) : errors.patients ? (
            <div className="dash-doctor-error">{errors.patients}</div>
          ) : patients.length === 0 ? (
            <div className="dash-doctor-no-results" style={{ padding: '20px', textAlign: 'center' }}>
              <p>No authorized patients</p>
              <p style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
                Patients must authorize you to view their data
              </p>
            </div>
          ) : (
            renderPatientSearch()
          )}
        </div>

        <div className="dash-doctor-main-content">
          {patients.length === 0 && ! loading.patients ?  (
            renderNoAuthorizedPatients()
          ) : selectedPatient ? (
            <>
              <div className="dash-doctor-patient-header">
                <div className="dash-doctor-patient-info">
                  <h2>{selectedPatient.name}</h2>
                  <span className="dash-doctor-patient-email">{selectedPatient.email}</span>
                </div>
                <div className="dash-doctor-patient-actions">
                  <DataImport
                    onImportComplete={handleImportComplete}
                    className="dash-doctor-data-import"
                  />
                  <button
                    onClick={handleRefreshData}
                    className="dash-doctor-refresh-button"
                  >
                    <FaSync className="dash-doctor-refresh-icon" />
                    Refresh Data
                  </button>
                </div>
              </div>

              <div className="dash-doctor-patient-data-grid">
                <div className="dash-doctor-constants-section">
                  <EnhancedPatientConstantsUI
                    patientId={selectedPatient.id}
                  />
                </div>

                <div className="dash-doctor-data-charts">
                  <div className="dash-doctor-correlation-chart">
                    <div className="dash-doctor-chart-header">
                      <h3>Combined Meal Analytics</h3>
                      <div className="dash-doctor-chart-controls">
                        <select
                          value={timeRange}
                          onChange={(e) => setTimeRange(e.target. value)}
                          className="dash-doctor-time-range-select"
                        >
                          <option value="24h">Last 24 Hours</option>
                          <option value="7d">Last 7 Days</option>
                          <option value="30d">Last 30 Days</option>
                        </select>
                      </div>
                    </div>
                    <GlycemicResponseTracker
                      patientId={selectedPatient.id}
                      userType="doctor"
                      timeRange={timeRange}
                      refreshTrigger={refreshTrigger}
                    />
                  </div>

                  <div className="dash-doctor-additional-charts">
                    <BloodSugarChart isDoctor={true} patientId={selectedPatient.id} />
                    <BloodSugarVisualization isDoctor={true} patientId={selectedPatient.id} />
                  </div>
                </div>

                <div className="dash-doctor-data-history">
                  <div className="dash-doctor-history-header">
                    <h3>Patient History</h3>
                    <div className="dash-doctor-history-tabs">
                      <button
                        className={`dash-doctor-history-tab ${activeTab === 'meals' ?  'dash-doctor-active' : ''}`}
                        onClick={() => setActiveTab('meals')}
                      >
                        Meals
                      </button>
                      <button
                        className={`dash-doctor-history-tab ${activeTab === 'activities' ?  'dash-doctor-active' : ''}`}
                        onClick={() => setActiveTab('activities')}
                      >
                        Activities
                      </button>
                    </div>
                  </div>
                  <div className="dash-doctor-history-content">
                    {activeTab === 'meals' ? (
                      <MealHistory isDoctor={true} patientId={selectedPatient.id} />
                    ) : (
                      <ActivityVisualization isDoctor={true} patientId={selectedPatient. id} />
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="dash-doctor-select-prompt">
              <FaUserMd className="dash-doctor-prompt-icon" />
              <p>Select a patient to view their data</p>
              <p style={{ fontSize: '14px', color: '#666', marginTop: '8px' }}>
                Only patients who have authorized you will appear in your list
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DoctorDashboard;





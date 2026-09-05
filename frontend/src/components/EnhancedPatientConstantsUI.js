import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback } from 'react';
import MedicationSchedule from './MedicationSchedule';
import './Charts/dashboard-components.css'; // Updated import
import { DEFAULT_PATIENT_CONSTANTS } from '../constants';
import { ACTIVITY_LEVELS } from '../constants';
import { useConstants } from '../contexts/ConstantsContext';
import axios from 'axios';

const EnhancedPatientConstantsUI = ({ patientId }) => {
  const { refreshConstants, fetchMedicationSchedules } = useConstants();
  const [constants, setConstants] = useState(DEFAULT_PATIENT_CONSTANTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const [expandedSections, setExpandedSections] = useState({
    basic: true,
    activity: true,
    absorption: true,
    diseases: true,
    medications: true
  });

  const fetchPatientConstants = useCallback(async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      const [constantsResponse, schedulesResponse] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/doctor/patient/${patientId}/constants`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(`${API_BASE_URL}/api/medication-schedule/${patientId}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      const constantsData = constantsResponse.data.constants;
      const schedulesData = schedulesResponse.data.schedules;

      const mergedConstants = {
        ...constantsData,
        medication_schedules: schedulesData.reduce((acc, schedule) => {
          acc[schedule.medication] = schedule;
          return acc;
        }, {})
      };

      setConstants(mergedConstants);
      setError(null);

    } catch (err) {
      console.error('Error fetching patient data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    fetchPatientConstants();

    const handleScheduleUpdate = () => {
      fetchPatientConstants();
    };

    window.addEventListener('medicationScheduleUpdated', handleScheduleUpdate);

    return () => {
      window.removeEventListener('medicationScheduleUpdated', handleScheduleUpdate);
    };
  }, [fetchPatientConstants]);

  const handleBasicConstantChange = (key, value) => {
    setConstants(prev => ({
      ...prev,
      [key]: key === 'daily_reset_hour' ? parseInt(value) || 0 : parseFloat(value) || 0
    }));
  };

  const handleDiseaseFactorChange = (disease, value) => {
    setConstants(prev => ({
      ...prev,
      disease_factors: {
        ...prev.disease_factors,
        [disease]: {
          ...prev.disease_factors[disease],
          factor: parseFloat(value) || 1.0
        }
      }
    }));
  };

  const handleMedicationFactorChange = (medication, value) => {
    setConstants(prev => ({
      ...prev,
      medication_factors: {
        ...prev.medication_factors,
        [medication]: {
          ...prev.medication_factors[medication],
          factor: parseFloat(value) || 1.0
        }
      }
    }));
  };

  const handleActivityCoefficientChange = (level, value) => {
    setConstants(prev => ({
      ...prev,
      activity_coefficients: {
        ...prev.activity_coefficients,
        [level]: parseFloat(value) || 0
      }
    }));
  };

  const handleAbsorptionModifierChange = (type, value) => {
    setConstants(prev => ({
      ...prev,
      absorption_modifiers: {
        ...prev.absorption_modifiers,
        [type]: parseFloat(value) || 0
      }
    }));
  };

  const handleActiveConditionToggle = (condition) => {
    setConstants(prev => ({
      ...prev,
      active_conditions: prev.active_conditions.includes(condition)
        ? prev.active_conditions.filter(c => c !== condition)
        : [...prev.active_conditions, condition]
    }));
  };

  const handleActiveMedicationToggle = (medication) => {
    setConstants(prev => ({
      ...prev,
      active_medications: prev.active_medications.includes(medication)
        ? prev.active_medications.filter(m => m !== medication)
        : [...prev.active_medications, medication]
    }));
  };

  const handleMedicationScheduleUpdate = async () => {
    try {
      await Promise.all([
        refreshConstants(),
        fetchMedicationSchedules(patientId)
      ]);
      await fetchPatientConstants();
    } catch (error) {
      console.error('Error updating medication schedules:', error);
      setError('Failed to update medication schedules');
    }
  };

  const resetToDefaults = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.post(
        `${API_BASE_URL}/api/doctor/patient/${patientId}/constants/reset`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      setConstants(response.data.constants);
      setMessage('Patient constants reset to defaults successfully');
      setTimeout(() => setMessage(''), 3000);

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      await axios.put(
        `${API_BASE_URL}/api/doctor/patient/${patientId}/constants`,
        { constants },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      await Promise.all([
        refreshConstants(),
        fetchMedicationSchedules(patientId),
        fetchPatientConstants()
      ]);

      setMessage('Patient constants updated successfully');
      setTimeout(() => setMessage(''), 3000);

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  if (loading) return <div className="dash-constants-loading">Loading...</div>;
  if (error) return <div className="dash-constants-error">Error: {error}</div>;

  return (
    <div className="dash-constants-patient-constants">
      {message && (
        <div className="dash-constants-message dash-constants-success">
          {message}
        </div>
      )}

      <div className="dash-constants-form">
        {/* Basic Constants Section */}
        <div className="dash-constants-constants-section">
          <h3 className="dash-constants-subsection-title" onClick={() => toggleSection('basic')}>
            Basic Constants
            <span>{expandedSections.basic ? '▼' : '▶'}</span>
          </h3>
          {expandedSections.basic && (
            <div className="dash-constants-constants-wrapper">
              <div className="dash-constants-form-group">
                <label>Insulin to Carb Ratio</label>
                <input
                  type="number"
                  value={constants.insulin_to_carb_ratio}
                  onChange={(e) => handleBasicConstantChange('insulin_to_carb_ratio', e.target.value)}
                  step="0.1"
                />
              </div>
              <div className="dash-constants-form-group">
                <label>Correction Factor</label>
                <input
                  type="number"
                  value={constants.correction_factor}
                  onChange={(e) => handleBasicConstantChange('correction_factor', e.target.value)}
                  step="1"
                />
              </div>
              <div className="dash-constants-form-group">
                <label>Target Glucose</label>
                <input
                  type="number"
                  value={constants.target_glucose}
                  onChange={(e) => handleBasicConstantChange('target_glucose', e.target.value)}
                  step="1"
                />
              </div>
              <div className="dash-constants-form-group">
                <label>
                  Carb-to-BG Factor
                  <span className="dash-constants-tooltip-icon" title="How much 1g of carbohydrate raises blood glucose in mg/dL">ⓘ</span>
                </label>
                <input
                  type="number"
                  value={constants.carb_to_bg_factor || 4.0}
                  onChange={(e) => handleBasicConstantChange('carb_to_bg_factor', e.target.value)}
                  min="1.0"
                  max="10.0"
                  step="0.1"
                />
                <small className="dash-constants-input-hint">mg/dL per gram of carbs (typically 4-5)</small>
              </div>
              <div className="dash-constants-form-group">
                <label>
                  Daily Reset Hour ⭐
                  <span className="dash-constants-tooltip-icon" title="Hour of day when daily cumulative effects reset (typically wake-up time)">ⓘ</span>
                </label>
                <select
                  value={constants.daily_reset_hour || 7}
                  onChange={(e) => handleBasicConstantChange('daily_reset_hour', e.target.value)}
                  style={{ padding: '8px', fontSize: '0.95em' }}
                >
                  {[...Array(24)].map((_, hour) => (
                    <option key={hour} value={hour}>
                      {hour === 0 ? '12:00 AM (Midnight)' :
                       hour === 12 ? '12:00 PM (Noon)' :
                       hour < 12 ? `${hour}:00 AM` :
                       `${hour - 12}:00 PM`}
                    </option>
                  ))}
                </select>
                <small className="dash-constants-input-hint">When patient's daily cumulative effects reset (default: 7:00 AM)</small>
              </div>
              <div className="dash-constants-form-group">
                <label>Protein Factor</label>
                <input
                  type="number"
                  value={constants.protein_factor}
                  onChange={(e) => handleBasicConstantChange('protein_factor', e.target.value)}
                  step="0.1"
                />
              </div>
              <div className="dash-constants-form-group">
                <label>Fat Factor</label>
                <input
                  type="number"
                  value={constants.fat_factor}
                  onChange={(e) => handleBasicConstantChange('fat_factor', e.target.value)}
                  step="0.1"
                />
              </div>
            </div>
          )}
        </div>

        {/* Activity Coefficients Section */}
        <div className="dash-constants-constants-section">
          <h3 className="dash-constants-subsection-title" onClick={() => toggleSection('activity')}>
            Activity Coefficients
            <span>{expandedSections.activity ? '▼' : '▶'}</span>
          </h3>
          {expandedSections.activity && (
            <div className="dash-constants-constants-wrapper">
              {ACTIVITY_LEVELS.map(activityLevel => {
                const level = activityLevel.value.toString();
                const currentValue = constants.activity_coefficients[level] || activityLevel.impact;

                return (
                  <div key={level} className="dash-constants-form-group">
                    <label>
                      {activityLevel.label}
                      {currentValue !== activityLevel.impact && (
                        <span className="dash-constants-default-value">
                          (Default: {activityLevel.impact.toFixed(2)}x)
                        </span>
                      )}
                    </label>
                    <input
                      type="number"
                      value={currentValue}
                      onChange={(e) => handleActivityCoefficientChange(level, e.target.value)}
                      step="0.1"
                      min="0"
                      className="dash-constants-number-input"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Absorption Modifiers Section */}
        <div className="dash-constants-constants-section">
          <h3 className="dash-constants-subsection-title" onClick={() => toggleSection('absorption')}>
            Absorption Modifiers
            <span>{expandedSections.absorption ? '▼' : '▶'}</span>
          </h3>
          {expandedSections.absorption && (
            <div className="dash-constants-constants-wrapper">
              {Object.entries(constants.absorption_modifiers).map(([type, value]) => (
                <div key={type} className="dash-constants-form-group">
                  <label>{type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</label>
                  <input
                    type="number"
                    value={value}
                    onChange={(e) => handleAbsorptionModifierChange(type, e.target.value)}
                    step="0.1"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Health Conditions Section */}
        <div className="dash-constants-constants-section">
          <h3 className="dash-constants-subsection-title" onClick={() => toggleSection('diseases')}>
            Health Conditions
            <span>{expandedSections.diseases ? '▼' : '▶'}</span>
          </h3>
          {expandedSections.diseases && (
            <div className="dash-constants-constants-wrapper">
              {Object.entries(constants.disease_factors || {}).map(([disease, data]) => (
                <div key={disease} className="dash-constants-form-group">
                  <div className="dash-constants-factor-header">
                    <input
                      type="checkbox"
                      checked={constants.active_conditions?.includes(disease)}
                      onChange={() => handleActiveConditionToggle(disease)}
                    />
                    <label>{disease.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</label>
                  </div>
                  <div className="dash-constants-factor-inputs">
                    <input
                      type="number"
                      value={data.factor}
                      onChange={(e) => handleDiseaseFactorChange(disease, e.target.value)}
                      step="0.1"
                      disabled={!constants.active_conditions?.includes(disease)}
                    />
                    <span className="dash-constants-factor-description">{data.description}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Medications Section */}
        <div className="dash-constants-constants-section">
          <h3 className="dash-constants-subsection-title" onClick={() => toggleSection('medications')}>
            Medications
            <span>{expandedSections.medications ? '▼' : '▶'}</span>
          </h3>
          {expandedSections.medications && (
            <div className="dash-constants-constants-wrapper">
              {/* Medication Selection Listbox */}
              <div className="dash-constants-medication-selector">
                <label className="dash-constants-selector-label">Select Medications</label>
                <div className="dash-constants-multi-select-container">
                  {Object.entries(constants.medication_factors || {}).map(([medication, data]) => (
                    <div key={medication} className="dash-constants-checkbox-item">
                      <input
                        type="checkbox"
                        id={`med-${medication}`}
                        checked={constants.active_medications?.includes(medication)}
                        onChange={() => handleActiveMedicationToggle(medication)}
                      />
                      <label htmlFor={`med-${medication}`}>
                        {medication.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                        <span className="dash-constants-medication-description">{data.description}</span>
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Active Medications Cards */}
              <div className="dash-constants-active-medications-grid">
                {Object.entries(constants.medication_factors || {})
                  .filter(([medication]) => constants.active_medications?.includes(medication))
                  .map(([medication, data]) => (
                    <MedicationSchedule
                      key={medication}
                      medication={medication}
                      medicationData={data}
                      patientId={patientId}
                      onScheduleUpdate={handleMedicationScheduleUpdate}
                      isActive={true}
                      onActiveMedicationToggle={handleActiveMedicationToggle}
                      onMedicationFactorChange={handleMedicationFactorChange}
                      className="dash-constants-medication-card"
                    />
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="dash-constants-button-group">
          <button
            onClick={resetToDefaults}
            className="dash-constants-reset-button"
            disabled={loading}
          >
            Reset to Defaults
          </button>
          <button
            onClick={handleSubmit}
            className="dash-constants-submit-button"
            disabled={loading}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="dash-constants-error-message">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default EnhancedPatientConstantsUI;





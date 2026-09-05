import API_BASE_URL from '../config';
import React, { useEffect, useState } from 'react';
import { useConstants } from '../contexts/ConstantsContext';
import { ACTIVITY_LEVELS } from '../constants';
import axios from 'axios';
import './Charts/dashboard-components.css';
import TimeInput from './TimeInput';
import TimeManager from '../utils/TimeManager';
import { calculateMedicationEffect } from '../utils/insulinPharmacodynamics'


const PatientConstants = () => {
  const { patientConstants, loading, error, refreshConstants } = useConstants();
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [scheduleError, setScheduleError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tempSchedule, setTempSchedule] = useState(null);
  const [medicationEffects, setMedicationEffects] = useState({});
  const [editingConstants, setEditingConstants] = useState(false);
  const [editableConstants, setEditableConstants] = useState({});
  const [constantsUpdateMessage, setConstantsUpdateMessage] = useState(null);

  // Simple date formatting function
  const formatDate = (dateString) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString();
    } catch (e) {
      return dateString;
    }
  };

  // Simple datetime formatting function
  const formatDateTime = (dateString) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch (e) {
      return dateString;
    }
  };

  const renderActivitySection = () => {
    if (loading) {
      return (
        <div className="dash-pc-constant-group">
          <h4>Activity Impact</h4>
          <div style={{ padding: '8px', color: '#666' }}>Loading activity impacts...</div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="dash-pc-constant-group">
          <h4>Activity Impact</h4>
          <div style={{ padding: '8px', color: '#f44336' }}>Error loading activity impacts: {error}</div>
        </div>
      );
    }

    const coefficients = patientConstants.activity_coefficients || {};

    return (
      <div className="dash-pc-constant-group">
        <h4>Activity Impact</h4>
        {ACTIVITY_LEVELS.map(level => {
          const value = coefficients[level.value] || level.impact;
          return (
            <p key={level.value}>
              <strong>{level.label}:</strong>{' '}
              <span className="dash-pc-constant-value">{value.toFixed(2)}x</span>
              {level.impact !== value && (
                <span className="dash-pc-description">
                  {' '}(Default: {level.impact.toFixed(2)}x)
                </span>
              )}
            </p>
          );
        })}
      </div>
    );
  };

  useEffect(() => {
    refreshConstants();

    const intervalId = setInterval(() => {
      refreshConstants();
      calculateMedicationEffects();
    }, 60000);

    return () => clearInterval(intervalId);
  }, [refreshConstants]);

  useEffect(() => {
    if (patientConstants && !loading) {
      calculateMedicationEffects();
    }
  }, [patientConstants, loading]);

  const calculateMedicationEffects = () => {
    if (!patientConstants?.active_medications) return;

    const effects = {};
    patientConstants.active_medications.forEach(medication => {
      const medData = patientConstants.medication_factors?.[medication];
      const schedule = patientConstants.medication_schedules?.[medication];

      if (medData && schedule && medData.duration_based) {
        const effect = calculateMedicationEffect(medication, medData, schedule);
        if (effect) {
          effects[medication] = effect;
        }
      }
    });

    setMedicationEffects(effects);
  };

  const handleScheduleUpdate = async (medication, updatedSchedule) => {
    try {
      setIsSubmitting(true);
      setScheduleError(null);

      const token = localStorage.getItem('token');
      const userId = patientConstants.patient_id;

      const response = await axios.post(
        `${API_BASE_URL}/api/medication-schedule/${userId}`,
        {
          medication,
          schedule: {
            startDate: new Date(updatedSchedule.startDate).toISOString(),
            endDate: new Date(updatedSchedule.endDate).toISOString(),
            dailyTimes: updatedSchedule.dailyTimes.filter(time => time).sort()
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.schedule) {
        await refreshConstants();
        calculateMedicationEffects();
        setEditingSchedule(null);
        setTempSchedule(null);
      }
    } catch (error) {
      console.error('Error updating schedule:', error.response?.data || error);
      setScheduleError(error.response?.data?.message || error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getNextDoseInfo = (medication) => {
    const schedule = patientConstants?.medication_schedules?.[medication];
    if (!schedule?.dailyTimes?.length) return null;

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const sortedTimes = [...schedule.dailyTimes].sort();
    let nextDose = null;

    for (const timeStr of sortedTimes) {
      const [hours, minutes] = timeStr.split(':').map(Number);
      if (hours > currentHour || (hours === currentHour && minutes > currentMinute)) {
        nextDose = {
          time: timeStr,
          date: today,
          isToday: true
        };
        break;
      }
    }

    if (!nextDose && sortedTimes.length > 0) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      nextDose = {
        time: sortedTimes[0],
        date: tomorrowStr,
        isToday: false
      };
    }

    return nextDose;
  };

  const formatTimeUntilNextDose = (nextDose) => {
    if (!nextDose) return "No scheduled doses";

    const now = new Date();
    const nextDoseDate = new Date(`${nextDose.date}T${nextDose.time}`);
    const diffMs = nextDoseDate - now;

    if (diffMs < 0) return "Past due";

    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffHrs === 0) {
      return `In ${diffMins} minute${diffMins !== 1 ? 's' : ''}`;
    }
    return `In ${diffHrs} hour${diffHrs !== 1 ? 's' : ''} and ${diffMins} minute${diffMins !== 1 ? 's' : ''}`;
  };

  const handleStartEditingConstants = () => {
    setEditableConstants({
      insulin_to_carb_ratio: patientConstants.insulin_to_carb_ratio,
      correction_factor: patientConstants.correction_factor,
      target_glucose: patientConstants.target_glucose,
      protein_factor: patientConstants.protein_factor,
      fat_factor: patientConstants.fat_factor,
      carb_to_bg_factor: patientConstants.carb_to_bg_factor,
      daily_reset_hour: patientConstants.daily_reset_hour || 7
    });
    setEditingConstants(true);
    setConstantsUpdateMessage(null);
  };

  const handleCancelEditingConstants = () => {
    setEditingConstants(false);
    setEditableConstants({});
    setConstantsUpdateMessage(null);
  };

  const handleConstantChange = (key, value) => {
    setEditableConstants(prev => ({
      ...prev,
      [key]: key === 'daily_reset_hour' ? parseInt(value) : parseFloat(value)
    }));
  };

  const handleSaveConstants = async () => {
    try {
      setIsSubmitting(true);
      setConstantsUpdateMessage(null);

      const token = localStorage.getItem('token');

      // Validate daily_reset_hour
      if (editableConstants.daily_reset_hour < 0 || editableConstants.daily_reset_hour > 23) {
        setConstantsUpdateMessage({
          type: 'error',
          text: 'Daily reset hour must be between 0 and 23'
        });
        return;
      }

      const response = await axios.put(
        `${API_BASE_URL}/api/patient/constants`,
        { constants: editableConstants },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.message) {
        setConstantsUpdateMessage({
          type: 'success',
          text: response.data.message
        });
        await refreshConstants();
        setEditingConstants(false);
        setTimeout(() => setConstantsUpdateMessage(null), 3000);
      }
    } catch (error) {
      console.error('Error updating constants:', error);
      setConstantsUpdateMessage({
        type: 'error',
        text: error.response?.data?.error || 'Failed to update constants'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatHourDisplay = (hour) => {
    if (hour === 0) return '12:00 AM (Midnight)';
    if (hour === 12) return '12:00 PM (Noon)';
    if (hour < 12) return `${hour}:00 AM`;
    return `${hour - 12}:00 PM`;
  };

  if (loading) return <div style={{ padding: '20px', textAlign: 'center' }}>Loading constants...</div>;
  if (error) return <div style={{ padding: '20px', textAlign: 'center', color: '#f44336' }}>Error loading constants: {error}</div>;
  if (!patientConstants) return null;

  return (
    <div className="dash-pc-constants-container">
      <h3 style={{ marginBottom: '24px', fontSize: '24px', fontWeight: '600' }}>Your Treatment Constants</h3>

      <div className="dash-pc-constants-grid">
        {/* Editable Basic Constants Section */}
        <div className="dash-pc-constant-group" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ margin: 0 }}>Your Settings</h4>
            {!editingConstants && (
              <button
                onClick={handleStartEditingConstants}
                className="dash-pc-edit-button"
                style={{ fontSize: '0.9em' }}
              >
                Edit Settings
              </button>
            )}
          </div>

          {editingConstants ? (
            <div style={{ padding: '16px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Insulin-to-Carb Ratio (ICR)
                  </label>
                  <input
                    type="number"
                    value={editableConstants.insulin_to_carb_ratio}
                    onChange={(e) => handleConstantChange('insulin_to_carb_ratio', e.target.value)}
                    step="0.1"
                    min="0.1"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Correction Factor (CF)
                  </label>
                  <input
                    type="number"
                    value={editableConstants.correction_factor}
                    onChange={(e) => handleConstantChange('correction_factor', e.target.value)}
                    step="1"
                    min="1"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Target Glucose (mg/dL)
                  </label>
                  <input
                    type="number"
                    value={editableConstants.target_glucose}
                    onChange={(e) => handleConstantChange('target_glucose', e.target.value)}
                    step="1"
                    min="60"
                    max="200"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Protein Factor
                  </label>
                  <input
                    type="number"
                    value={editableConstants.protein_factor}
                    onChange={(e) => handleConstantChange('protein_factor', e.target.value)}
                    step="0.1"
                    min="0"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Fat Factor
                  </label>
                  <input
                    type="number"
                    value={editableConstants.fat_factor}
                    onChange={(e) => handleConstantChange('fat_factor', e.target.value)}
                    step="0.1"
                    min="0"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Carb-to-BG Factor (mg/dL per gram)
                  </label>
                  <input
                    type="number"
                    value={editableConstants.carb_to_bg_factor}
                    onChange={(e) => handleConstantChange('carb_to_bg_factor', e.target.value)}
                    step="0.1"
                    min="1"
                    max="10"
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                  <small style={{ color: '#666', fontSize: '0.85em' }}>
                    How much 1g carbs raises blood glucose (typically 4-5)
                  </small>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>
                    Daily Reset Hour ⭐ NEW
                  </label>
                  <select
                    value={editableConstants.daily_reset_hour}
                    onChange={(e) => handleConstantChange('daily_reset_hour', e.target.value)}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  >
                    {[...Array(24)].map((_, hour) => (
                      <option key={hour} value={hour}>
                        {formatHourDisplay(hour)}
                      </option>
                    ))}
                  </select>
                  <small style={{ color: '#666', fontSize: '0.85em' }}>
                    When your daily cumulative effects reset (typically wake-up time)
                  </small>
                </div>
              </div>

              <div style={{ marginTop: '16px', display: 'flex', gap: '12px' }}>
                <button
                  onClick={handleSaveConstants}
                  className="dash-pc-button dash-pc-button-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={handleCancelEditingConstants}
                  className="dash-pc-button dash-pc-button-secondary"
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
              </div>

              {constantsUpdateMessage && (
                <div style={{
                  marginTop: '12px',
                  padding: '12px',
                  backgroundColor: constantsUpdateMessage.type === 'success' ? '#e8f5e9' : '#ffebee',
                  color: constantsUpdateMessage.type === 'success' ? '#2e7d32' : '#c62828',
                  borderRadius: '4px',
                  fontSize: '0.9em'
                }}>
                  {constantsUpdateMessage.text}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>ICR:</strong> <span className="dash-pc-constant-value">{patientConstants.insulin_to_carb_ratio}</span>
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>CF:</strong> <span className="dash-pc-constant-value">{patientConstants.correction_factor}</span>
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>Target:</strong> <span className="dash-pc-constant-value">{patientConstants.target_glucose}</span> mg/dL
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>Protein:</strong> <span className="dash-pc-constant-value">{patientConstants.protein_factor}</span>
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>Fat:</strong> <span className="dash-pc-constant-value">{patientConstants.fat_factor}</span>
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>Carb-to-BG:</strong> <span className="dash-pc-constant-value">{patientConstants.carb_to_bg_factor}</span> mg/dL per g
                </p>
              </div>
              <div>
                <p style={{ margin: '4px 0' }}>
                  <strong>Daily Reset:</strong> <span className="dash-pc-constant-value">{formatHourDisplay(patientConstants.daily_reset_hour || 7)}</span>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Basic Constants Section - REMOVED, now in editable section above */}
        {/* <div className="dash-pc-constant-group">
          <h4>Basic Constants</h4>
          <p>ICR: <span className="dash-pc-constant-value">{patientConstants.insulin_to_carb_ratio}</span></p>
          <p>CF: <span className="dash-pc-constant-value">{patientConstants.correction_factor}</span></p>
          <p>Target: <span className="dash-pc-constant-value">{patientConstants.target_glucose}</span> mg/dL</p>
          <p>Protein: <span className="dash-pc-constant-value">{patientConstants.protein_factor}</span></p>
          <p>Fat: <span className="dash-pc-constant-value">{patientConstants.fat_factor}</span></p>
        </div> */}

        {/* Activity Impact Section */}
        {renderActivitySection()}

        {/* Absorption Modifiers Section */}
        <div className="dash-pc-constant-group">
          <h4>Absorption Modifiers</h4>
          {Object.entries(patientConstants.absorption_modifiers || {}).map(([type, value]) => (
            <p key={type}>
              <strong>{type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:</strong>{' '}
              <span className="dash-pc-constant-value">{value}x</span>
            </p>
          ))}
        </div>

        {/* Active Health Conditions Section */}
        <div className="dash-pc-constant-group">
          <h4>Active Health Conditions</h4>
          {patientConstants.active_conditions?.length > 0 ? (
            patientConstants.active_conditions.map(condition => {
              const conditionData = patientConstants.disease_factors?.[condition] || {};
              return (
                <div key={condition} style={{ marginBottom: '12px' }}>
                  <p style={{ margin: '0 0 4px 0' }}>
                    <strong>
                      {condition.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </strong>
                  </p>
                  <p style={{ margin: '0' }}>
                    Impact: <span className="dash-pc-constant-value">{conditionData.factor}x</span>
                  </p>
                  <span className="dash-pc-description">{conditionData.description}</span>
                </div>
              );
            })
          ) : (
            <p>No active health conditions</p>
          )}
        </div>

        {/* Active Medications Section */}
        <div className="dash-pc-constant-group">
          <h4>Active Medications</h4>
          {patientConstants.active_medications?.length > 0 ? (
            patientConstants.active_medications.map(medication => {
              const medData = patientConstants.medication_factors?.[medication] || {};
              const effect = medicationEffects[medication];
              const effectPercentage = effect ? ((effect.factor - 1) * 100).toFixed(1) : 0;

              return (
                <div key={medication} style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #e0e0e0' }}>
                  <p style={{ margin: '0 0 4px 0' }}>
                    <strong>
                      {medication.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </strong>
                  </p>
                  <p style={{ margin: '0 0 4px 0' }}>
                    Impact: <span className="dash-pc-constant-value">{medData.factor}x</span>
                  </p>
                  <span className="dash-pc-description">{medData.description}</span>

                  {medData.duration_based && (
                    <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                      <div style={{ display: 'flex', gap: '12px', fontSize: '0.85em', marginBottom: '8px' }}>
                        <span>Onset: {medData.onset_hours}h</span>
                        <span>Peak: {medData.peak_hours}h</span>
                        <span>Duration: {medData.duration_hours}h</span>
                      </div>

                      {effect && (
                        <div style={{ marginTop: '8px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span style={{ fontSize: '0.9em', fontWeight: '500' }}>Current Effect:</span>
                            <span style={{
                              fontSize: '0.9em',
                              fontWeight: '600',
                              color: parseFloat(effectPercentage) > 5 ? '#4caf50' :
                                     parseFloat(effectPercentage) > 0 ? '#8bc34a' :
                                     parseFloat(effectPercentage) < -5 ? '#f44336' :
                                     parseFloat(effectPercentage) < 0 ? '#ff9800' : '#666'
                            }}>
                              {effectPercentage > 0 ? '+' : ''}{effectPercentage}%
                            </span>
                          </div>

                          {effect.lastDose && (
                            <div style={{ fontSize: '0.85em', color: '#666', marginBottom: '4px' }}>
                              <div>Last dose: {formatDateTime(effect.lastDose)}</div>
                              <div>({effect.hoursSinceLastDose?.toFixed(1)}h ago)</div>
                            </div>
                          )}

                          <div style={{ fontSize: '0.85em', marginBottom: '4px' }}>
                            Status: <strong>{effect.status}</strong>
                          </div>

                          <div style={{
                            height: '6px',
                            backgroundColor: '#e0e0e0',
                            borderRadius: '3px',
                            overflow: 'hidden',
                            marginTop: '8px'
                          }}>
                            <div style={{
                              width: `${Math.min(100, Math.abs(effectPercentage))}%`,
                              height: '100%',
                              backgroundColor: parseFloat(effectPercentage) >= 0 ? '#4caf50' : '#f44336',
                              transition: 'width 0.3s ease'
                            }}></div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p>No active medications</p>
          )}
        </div>
      </div>

      {/* Medication Schedules Section */}
      <div style={{ marginTop: '32px' }}>
        <h4 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: '600' }}>Medication Schedules</h4>
        <div className="dash-pc-medication-schedules-grid">
          {patientConstants.active_medications?.length > 0 ? (
            patientConstants.active_medications.map(medication => {
              const schedule = patientConstants.medication_schedules?.[medication] || {
                startDate: new Date().toISOString(),
                endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                dailyTimes: ['']
              };
              const isEditing = editingSchedule === medication;
              const nextDose = getNextDoseInfo(medication);

              return (
                <div key={medication} className="dash-pc-medication-schedule">
                  <h5>{medication.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</h5>

                  {isEditing ? (
                    <div className="dash-pc-schedule-editor">
                      <div className="dash-pc-date-inputs">
                        <div className="dash-pc-input-group">
                          <label>Start Date:</label>
                          <TimeInput
                            mode="timepoint"
                            value={tempSchedule?.startDate || schedule.startDate}
                            onChange={(value) => {
                              setTempSchedule(prev => ({
                                ...prev || schedule,
                                startDate: value
                              }));
                            }}
                            dateOnly={true}
                            minDate={TimeManager.getCurrentTimeISOString()}
                          />
                        </div>

                        <div className="dash-pc-input-group">
                          <label>End Date:</label>
                          <TimeInput
                            mode="timepoint"
                            value={tempSchedule?.endDate || schedule.endDate}
                            onChange={(value) => {
                              setTempSchedule(prev => ({
                                ...prev || schedule,
                                endDate: value
                              }));
                            }}
                            dateOnly={true}
                            minDate={tempSchedule?.startDate || schedule.startDate}
                          />
                        </div>
                      </div>

                      <div className="dash-pc-time-inputs">
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Medication Times:</label>
                        {(tempSchedule?.dailyTimes || schedule.dailyTimes).map((time, index) => (
                          <div key={index} className="dash-pc-time-input">
                            <input
                              type="time"
                              value={time}
                              onChange={(e) => {
                                const newTimes = [...(tempSchedule?.dailyTimes || schedule.dailyTimes)];
                                newTimes[index] = e.target.value;
                                setTempSchedule(prev => ({
                                  ...prev || schedule,
                                  dailyTimes: newTimes.sort()
                                }));
                              }}
                            />
                            {(tempSchedule?.dailyTimes || schedule.dailyTimes).length > 1 && (
                              <button
                                onClick={() => {
                                  const newTimes = (tempSchedule?.dailyTimes || schedule.dailyTimes)
                                    .filter((_, i) => i !== index);
                                  setTempSchedule(prev => ({
                                    ...prev || schedule,
                                    dailyTimes: newTimes
                                  }));
                                }}
                                style={{
                                  padding: '4px 8px',
                                  backgroundColor: '#f44336',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer'
                                }}
                                title="Remove this time"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          onClick={() => {
                            setTempSchedule(prev => ({
                              ...prev || schedule,
                              dailyTimes: [...(prev?.dailyTimes || schedule.dailyTimes), '']
                            }));
                          }}
                          className="dash-pc-button dash-pc-button-secondary"
                          style={{ marginTop: '8px' }}
                        >
                          + Add Time
                        </button>
                      </div>

                      <div className="dash-pc-button-group">
                        <button
                          onClick={async () => {
                            if (tempSchedule) {
                              await handleScheduleUpdate(medication, tempSchedule);
                            }
                          }}
                          className="dash-pc-button dash-pc-button-primary"
                          disabled={isSubmitting}
                        >
                          {isSubmitting ? 'Saving...' : 'Save Schedule'}
                        </button>
                        <button
                          onClick={() => {
                            setTempSchedule(null);
                            setEditingSchedule(null);
                            setScheduleError(null);
                          }}
                          className="dash-pc-button dash-pc-button-secondary"
                          disabled={isSubmitting}
                        >
                          Cancel
                        </button>
                      </div>

                      {scheduleError && (
                        <div style={{
                          marginTop: '12px',
                          padding: '12px',
                          backgroundColor: '#ffebee',
                          color: '#c62828',
                          borderRadius: '4px',
                          fontSize: '0.9em'
                        }}>
                          {scheduleError}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="dash-pc-schedule-view">
                      <div style={{ marginBottom: '12px' }}>
                        <p style={{ margin: '4px 0' }}>
                          <strong>Start:</strong> {formatDate(schedule.startDate)}
                        </p>
                        <p style={{ margin: '4px 0' }}>
                          <strong>End:</strong> {formatDate(schedule.endDate)}
                        </p>
                        <p style={{ margin: '4px 0' }}>
                          <strong>Daily Times:</strong> {schedule.dailyTimes.join(', ') || 'None set'}
                        </p>

                        {nextDose && (
                          <>
                            <p style={{ margin: '4px 0' }}>
                              <strong>Next Dose:</strong>{' '}
                              <span style={{ color: '#1976d2', fontWeight: '500' }}>
                                {nextDose.time} {nextDose.isToday ? 'Today' : 'Tomorrow'}
                              </span>
                            </p>
                            <p style={{ margin: '4px 0' }}>
                              <strong>Time Until:</strong>{' '}
                              <span style={{ color: '#f57c00', fontWeight: '500' }}>
                                {formatTimeUntilNextDose(nextDose)}
                              </span>
                            </p>
                          </>
                        )}
                      </div>

                      <button
                        onClick={() => {
                          setEditingSchedule(medication);
                          setTempSchedule(null);
                          setScheduleError(null);
                        }}
                        className="dash-pc-edit-button"
                      >
                        Edit Schedule
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#666' }}>No active medications</p>
          )}
        </div>
      </div>

      <div style={{
        marginTop: '32px',
        paddingTop: '16px',
        borderTop: '1px solid #e0e0e0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <span style={{ fontSize: '0.9em', color: '#666' }}>
          Last updated: {new Date().toLocaleString()}
        </span>
        <button
          onClick={() => {
            refreshConstants();
            calculateMedicationEffects();
          }}
          className="dash-pc-button dash-pc-button-primary"
        >
          Refresh Constants
        </button>
      </div>
    </div>
  );
};

export default PatientConstants;





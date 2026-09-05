import API_BASE_URL from '../config';
import React, { useState, useEffect } from 'react';
import { useConstants } from '../contexts/ConstantsContext';
import './Charts/dashboard-components.css'; // Updated import
import axios from 'axios';
import { validateMedicationSchedule } from './EnhancedPatientConstantsCalc';
import TimeInput from './TimeInput';
import TimeManager from '../utils/TimeManager';
import { calculateMedicationEffect } from '../utils/insulinPharmacodynamics'


const MedicationSchedule = ({
  medication,
  medicationData,
  patientId,
  onScheduleUpdate,
  className,
  isActive,
  onActiveMedicationToggle,
  onMedicationFactorChange
}) => {
  const {
    updateMedicationSchedule,
    medicationSchedules,
    fetchMedicationSchedules,
    refreshConstants
  } = useConstants();

  const [schedule, setSchedule] = useState({
    startDate: '',
    endDate: '',
    dailyTimes: [''],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [currentSchedule, setCurrentSchedule] = useState(null);
  const [medicationEffect, setMedicationEffect] = useState(null);

  useEffect(() => {
    const loadInitialSchedule = async () => {
      try {
        const existingSchedule = medicationSchedules[medication];

        if (existingSchedule) {
          setCurrentSchedule(existingSchedule);
          setSchedule({
            startDate: existingSchedule.startDate.slice(0, 10),
            endDate: existingSchedule.endDate.slice(0, 10),
            dailyTimes: existingSchedule.dailyTimes
          });
        } else {
          const token = localStorage.getItem('token');
          const response = await axios.get(
            `${API_BASE_URL}/api/medication-schedule/${patientId}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );

          if (response.data.schedules) {
            const medicationSchedule = response.data.schedules.find(
              schedule => schedule.medication === medication
            );

            if (medicationSchedule) {
              setCurrentSchedule(medicationSchedule);
              setSchedule({
                startDate: medicationSchedule.startDate.slice(0, 10),
                endDate: medicationSchedule.endDate.slice(0, 10),
                dailyTimes: medicationSchedule.dailyTimes
              });
            } else {
              const currentDate = new Date();
              currentDate.setHours(0, 0, 0, 0);
              setSchedule({
                startDate: currentDate.toISOString().slice(0, 10),
                endDate: new Date(currentDate.getTime() + 30 * 24 * 60 * 60 * 1000)
                  .toISOString().slice(0, 10),
                dailyTimes: ['']
              });
            }
          }
        }
      } catch (error) {
        console.error('Error loading schedule:', error);
        setError(error.message);
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);
        setSchedule({
          startDate: currentDate.toISOString().slice(0, 10),
          endDate: new Date(currentDate.getTime() + 30 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10),
          dailyTimes: ['']
        });
      }
    };

    loadInitialSchedule();

    if (medicationData?.duration_based && currentSchedule) {
      const effect = calculateMedicationEffect(
        medication,
        medicationData,
        currentSchedule
      );
      setMedicationEffect(effect);
    }

    const effectInterval = setInterval(() => {
      if (medicationData?.duration_based && currentSchedule) {
        const effect = calculateMedicationEffect(
          medication,
          medicationData,
          currentSchedule
        );
        setMedicationEffect(effect);
      }
    }, 60000);

    return () => clearInterval(effectInterval);
  }, [medication, medicationData, medicationSchedules, patientId, currentSchedule]);

  const validateSchedule = () => {
    return validateMedicationSchedule(schedule);
  };

  const handleAddTime = () => {
    setSchedule(prev => ({
      ...prev,
      dailyTimes: [...prev.dailyTimes, '']
    }));
  };

  const handleRemoveTime = (index) => {
    setSchedule(prev => ({
      ...prev,
      dailyTimes: prev.dailyTimes.filter((_, i) => i !== index)
    }));
  };

  const handleTimeChange = (index, value) => {
    setSchedule(prev => {
      const updatedTimes = [...prev.dailyTimes];
      updatedTimes[index] = value;
      return {
        ...prev,
        dailyTimes: updatedTimes.sort()
      };
    });
  };

  const handleStartDateChange = (dateValue) => {
    const formattedDate = dateValue.slice(0, 10);
    setSchedule(prev => ({...prev, startDate: formattedDate}));
  };

  const handleEndDateChange = (dateValue) => {
    const formattedDate = dateValue.slice(0, 10);
    setSchedule(prev => ({...prev, endDate: formattedDate}));
  };

  const handleScheduleUpdate = async () => {
    try {
      setIsSubmitting(true);
      setError(null);

      const validationErrors = validateSchedule();
      if (validationErrors.length > 0) {
        throw new Error(validationErrors.join('\n'));
      }

      const updatedSchedule = {
        startDate: new Date(schedule.startDate).toISOString(),
        endDate: new Date(schedule.endDate).toISOString(),
        dailyTimes: schedule.dailyTimes.filter(time => time).sort()
      };

      const token = localStorage.getItem('token');
      const response = await axios({
        method: 'post',
        url: `${API_BASE_URL}/api/medication-schedule/${patientId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        data: {
          medication,
          schedule: updatedSchedule
        }
      });

      if (response.data.schedule) {
        setCurrentSchedule(response.data.schedule);
        await Promise.all([
          refreshConstants(),
          fetchMedicationSchedules(patientId)
        ]);

        if (onScheduleUpdate) {
          await onScheduleUpdate();
        }

        window.dispatchEvent(new CustomEvent('medicationScheduleUpdated', {
          detail: { medication, schedule: response.data.schedule }
        }));
      }
    } catch (error) {
      console.error('Error updating medication schedule:', error);
      setError(error.response?.data?.message || error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getNextDoseInfo = () => {
    if (!currentSchedule?.dailyTimes?.length) return null;

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const sortedTimes = [...currentSchedule.dailyTimes].sort();
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

  const nextDose = getNextDoseInfo();

  const formatTimeUntilNextDose = () => {
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

  const getEffectPercentage = () => {
    if (!medicationEffect) return 0;
    return ((medicationEffect.factor - 1) * 100).toFixed(1);
  };

  const getEffectClass = () => {
    if (!medicationEffect) return '';

    const effect = medicationEffect.factor - 1;
    if (effect > 0.1) return 'dash-med-strong-effect';
    if (effect > 0) return 'dash-med-moderate-effect';
    if (effect < -0.1) return 'dash-med-strong-negative-effect';
    if (effect < 0) return 'dash-med-moderate-negative-effect';
    return '';
  };

  return (
    <div className={`dash-med-medication-schedule ${className || ''}`}>
      <div className="dash-med-schedule-container">
        <div className="dash-med-header-row">
          <div className="dash-med-medication-header">
            <input
              type="checkbox"
              checked={isActive}
              onChange={() => onActiveMedicationToggle(medication)}
              className="dash-med-medication-checkbox"
            />
            <h3 className="dash-med-medication-title">
              {medication.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
            </h3>
          </div>

          {medicationData && (
            <div className="dash-med-factor-inputs">
              <label>Factor:</label>
              <input
                type="number"
                value={medicationData.factor}
                onChange={(e) => onMedicationFactorChange(medication, e.target.value)}
                step="0.1"
                disabled={!isActive}
                className="dash-med-factor-input"
              />
              <span className="dash-med-factor-description">{medicationData.description}</span>
            </div>
          )}
        </div>

        {isActive && (
          <>
            <div className="dash-med-date-time-container">
              <div className="dash-med-date-inputs-row">
                <div className="dash-med-input-group">
                  <label htmlFor={`startDate-${medication}`}>Start Date:</label>
                  <TimeInput
                    mode="timepoint"
                    value={schedule.startDate ? `${schedule.startDate}T00:00` : ''}
                    onChange={handleStartDateChange}
                    className="dash-med-date-time-input"
                    label=""
                  />
                </div>

                <div className="dash-med-input-group">
                  <label htmlFor={`endDate-${medication}`}>End Date:</label>
                  <TimeInput
                    mode="timepoint"
                    value={schedule.endDate ? `${schedule.endDate}T00:00` : ''}
                    onChange={handleEndDateChange}
                    className="dash-med-date-time-input"
                    label=""
                  />
                </div>
              </div>

              <div className="dash-med-times-list">
                <h4>Daily Medication Times</h4>
                {schedule.dailyTimes.map((time, index) => (
                  <div key={index} className="dash-med-time-input-group">
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => handleTimeChange(index, e.target.value)}
                      className="dash-med-time-input"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveTime(index)}
                      className="dash-med-remove-time-button"
                      disabled={schedule.dailyTimes.length === 1}
                      title="Remove time"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={handleAddTime}
                  className="dash-med-add-time-button"
                  title="Add another time"
                >
                  + Add Time
                </button>
              </div>

              <button
                onClick={handleScheduleUpdate}
                disabled={isSubmitting || !schedule.startDate || !schedule.endDate || schedule.dailyTimes.some(time => !time)}
                className="dash-med-update-button"
              >
                {isSubmitting ? 'Updating...' : 'Update Schedule'}
              </button>
            </div>

            {error && (
              <div className="dash-med-error">
                {error.split('\n').map((err, index) => (
                  <p key={index}>{err}</p>
                ))}
              </div>
            )}

            {currentSchedule && (
              <div className="dash-med-current-schedule-container">
                <h4>Current Schedule</h4>
                <div className="dash-med-current-schedule-details">
                  <div className="dash-med-schedule-row">
                    <span>Start Date:</span>
                    <span>{TimeManager.formatDateTime(currentSchedule.startDate).split(',')[0]}</span>
                  </div>
                  <div className="dash-med-schedule-row">
                    <span>End Date:</span>
                    <span>{TimeManager.formatDateTime(currentSchedule.endDate).split(',')[0]}</span>
                  </div>
                  <div className="dash-med-schedule-row">
                    <span>Daily Times:</span>
                    <span>{currentSchedule.dailyTimes.join(', ')}</span>
                  </div>
                  {nextDose && (
                    <>
                      <div className="dash-med-schedule-row">
                        <span>Next Dose:</span>
                        <span className="dash-med-next-dose">
                          {nextDose.time} {nextDose.isToday ? 'Today' : 'Tomorrow'}
                        </span>
                      </div>
                      <div className="dash-med-schedule-row">
                        <span>Time Until Next:</span>
                        <span className="dash-med-time-until">
                          {formatTimeUntilNextDose()}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {medicationData.duration_based && (
              <div className="dash-med-pharmacokinetics">
                <h4>Pharmacokinetic Profile</h4>
                <div className="dash-med-kinetic-row">
                  <span>Onset:</span>
                  <span>{medicationData.onset_hours} hours</span>
                </div>
                <div className="dash-med-kinetic-row">
                  <span>Peak Effect:</span>
                  <span>{medicationData.peak_hours} hours</span>
                </div>
                <div className="dash-med-kinetic-row">
                  <span>Duration:</span>
                  <span>{medicationData.duration_hours} hours</span>
                </div>

                {medicationEffect && (
                  <div className="dash-med-current-effect">
                    <h4>Current Effect</h4>
                    <div className="dash-med-effect-row">
                      <span>Status:</span>
                      <span>{medicationEffect.status}</span>
                    </div>

                    {medicationEffect.lastDose && (
                      <>
                        <div className="dash-med-effect-row">
                          <span>Last Dose:</span>
                          <span>{TimeManager.formatDateTime(medicationEffect.lastDose)}</span>
                        </div>
                        <div className="dash-med-effect-row">
                          <span>Hours Since Dose:</span>
                          <span>{medicationEffect.hoursSinceLastDose?.toFixed(1)}h</span>
                        </div>
                      </>
                    )}

                    <div className="dash-med-effect-row">
                      <span>Current Effect:</span>
                      <span className={`dash-med-effect-strength ${getEffectClass()}`}>
                        {getEffectPercentage()}%
                        {parseFloat(getEffectPercentage()) > 0 ? ' increase' : ' decrease'}
                      </span>
                    </div>

                    <div className="dash-med-effect-visualization">
                      <div
                        className="dash-med-effect-bar"
                        style={{
                          width: `${Math.min(100, Math.abs(getEffectPercentage()))}%`,
                          backgroundColor: parseFloat(getEffectPercentage()) >= 0 ? '#4caf50' : '#f44336'
                        }}
                      ></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default MedicationSchedule;





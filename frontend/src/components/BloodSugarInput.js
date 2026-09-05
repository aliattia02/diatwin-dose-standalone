import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { FaFileImport, FaSync, FaHistory, FaInfoCircle } from 'react-icons/fa';
import './Charts/input-components.css';
import TimeInput from './TimeInput';
import TimeManager from '../utils/TimeManager';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';

const BloodSugarInput = ({
  onBloodSugarChange,
  initialValue = '',
  disabled = false,
  standalone = true,
  className = '',
  onSubmitSuccess = null
}) => {
  const [localValue, setLocalValue] = useState('');
  const [unit, setUnit] = useState('mg/dL');
  const [status, setStatus] = useState({ type: '', message: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [readingTime, setReadingTime] = useState(TimeManager.getCurrentTimeISOString());
  const [recentReadings, setRecentReadings] = useState([]);
  const [showRecentReadings, setShowRecentReadings] = useState(false);
  const [importStatus, setImportStatus] = useState(null);

  // Context functions needed to refresh the active-effects pipeline after standalone submit
  const { fetchLast24hData, fetchRecentMeals: fetchRecentMealsContext, currentViewMode } = useBloodSugarData();

  const fileInputRef = useRef(null);

  useEffect(() => {
    if (initialValue) {
      setLocalValue(unit === 'mmol/L' ? mgdlToMmol(initialValue) : initialValue);
    }
  }, [initialValue, unit]);

  useEffect(() => {
    if (standalone) {
      fetchRecentReadings();
    }
  }, [standalone]);

  const mmolToMgdl = (mmol) => Math.round(mmol * 18);
  const mgdlToMmol = (mgdl) => (mgdl / 18).toFixed(1);

  const validateBloodSugar = (value, unit) => {
    const num = parseFloat(value);
    if (isNaN(num)) return 'Please enter a valid number';
    if (num < 0) return 'Blood sugar cannot be negative';

    if (unit === 'mg/dL') {
      if (num > 600) return 'Blood sugar value seems too high';
    } else {
      if (num > 33.3) return 'Blood sugar value seems too high';
    }
    return '';
  };

  const handleInputChange = (e) => {
    const inputValue = e.target.value;
    setLocalValue(inputValue);
    setStatus({ type: '', message: '' });
  };

  const handleBlur = () => {
    if (localValue && !isNaN(parseFloat(localValue))) {
      const error = validateBloodSugar(localValue, unit);
      if (error) {
        setStatus({ type: 'error', message: error });
        return;
      }

      const bloodSugarMgdl = unit === 'mmol/L'
        ? mmolToMgdl(parseFloat(localValue))
        : parseFloat(localValue);

      if (onBloodSugarChange) {
        const utcTimestamp = TimeManager.localToUTCISOString(readingTime);
        onBloodSugarChange(bloodSugarMgdl, utcTimestamp);
      }
    }
  };

  const handleReadingTimeChange = (timeValue) => {
    setReadingTime(timeValue);

    if (localValue && !isNaN(parseFloat(localValue))) {
      const bloodSugarMgdl = unit === 'mmol/L'
        ? mmolToMgdl(parseFloat(localValue))
        : parseFloat(localValue);

      if (onBloodSugarChange) {
        const utcTimestamp = TimeManager.localToUTCISOString(timeValue);
        onBloodSugarChange(bloodSugarMgdl, utcTimestamp);
      }
    }
  };

  const fetchRecentReadings = useCallback(async () => {
    if (!standalone) return;

    try {
      setIsLoading(true);
      const token = localStorage.getItem('token');
      if (!token) {
        console.warn('No authentication token found');
        return;
      }

      const response = await axios.get(
        `${API_BASE_URL}/api/blood-sugar`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          params: { limit: 5, filter_by: 'reading_time' }
        }
      );

      if (response.data && Array.isArray(response.data)) {
        const formattedReadings = response.data.map(reading => ({
          ...reading,
          displayValue: unit === 'mmol/L'
            ? mgdlToMmol(reading.bloodSugar)
            : reading.bloodSugar.toFixed(0),
          displayUnit: unit,
          readingTime: reading.bloodSugarTimestamp
            ? TimeManager.utcToLocalString(reading.bloodSugarTimestamp)
            : TimeManager.utcToLocalString(reading.timestamp)
        }));

        setRecentReadings(formattedReadings);
      }
    } catch (error) {
      console.error('Error fetching recent readings:', error);
    } finally {
      setIsLoading(false);
    }
  }, [standalone, unit]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!standalone) return;

    const error = validateBloodSugar(localValue, unit);
    if (error) {
      setStatus({ type: 'error', message: error });
      return;
    }

    setIsLoading(true);
    try {
      const token = localStorage.getItem('token');
      const bloodSugarMgdl = unit === 'mmol/L'
        ? mmolToMgdl(parseFloat(localValue))
        : parseFloat(localValue);

      const utcTimestamp = TimeManager.localToUTCISOString(readingTime);

      const response = await fetch(`${API_BASE_URL}/api/meal`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mealType: 'blood_sugar_only',
          foodItems: [],
          activities: [],
          // ✅ FIX: Send mealTime so the backend sets meal_timestamp = reading time,
          // not record-creation time. Without this, the 'timestamp' field in the
          // blood_sugar doc ends up as datetime.utcnow() (creation time), causing
          // wrong results if the fallback timestamp branch is used for sorting.
          mealTime: utcTimestamp,
          bloodSugar: bloodSugarMgdl,
          bloodSugarSource: 'standalone',
          bloodSugarTimestamp: utcTimestamp,
          notes: notes,
          recordingType: 'standalone_blood_sugar',
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to record blood sugar');
      }

      const result = await response.json();

      setStatus({ type: 'success', message: 'Blood sugar level recorded successfully' });
      setLocalValue('');
      setNotes('');
      setReadingTime(TimeManager.getCurrentTimeISOString());

      fetchRecentReadings();

      if (onBloodSugarChange) onBloodSugarChange('');
      if (onSubmitSuccess) onSubmitSuccess(result);

      // Standalone mode: refresh the context so the new reading
      // flows into calculateActiveEffects → ActiveEffectsDisplay immediately.
      if (standalone) {
        await fetchRecentMealsContext(currentViewMode, true);
        fetchLast24hData();
      }

    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Error recording blood sugar level' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileExt = file.name.split('.').pop().toLowerCase();
    if (fileExt !== 'csv' && fileExt !== 'json') {
      setImportStatus({
        type: 'error',
        message: 'Invalid file format. Please select a CSV or JSON file.'
      });
      return;
    }

    setIsLoading(true);
    setImportStatus({ type: 'info', message: 'Validating file...' });

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'blood_sugar');

      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Authentication token not found');
      }

      const validationResponse = await axios.post(
        `${API_BASE_URL}/api/import/validate`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      if (!validationResponse.data.valid) {
        setImportStatus({
          type: 'error',
          message: 'File validation failed',
          details: validationResponse.data.errors?.join('\n')
        });
        setIsLoading(false);
        return;
      }

      setImportStatus({ type: 'info', message: 'Importing data...' });

      const importResponse = await axios.post(
        `${API_BASE_URL}/api/import`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      const results = importResponse.data.results;

      setImportStatus({
        type: 'success',
        message: `Successfully imported ${results.blood_sugar_imported || 0} blood sugar readings`,
      });

      await fetchRecentReadings();

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

    } catch (error) {
      console.error('Error importing data:', error);
      setImportStatus({
        type: 'error',
        message: 'Failed to import data',
        details: error.response?.data?.error || error.message || 'Unknown error occurred'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const toggleRecentReadings = () => {
    setShowRecentReadings(prev => !prev);
    if (!showRecentReadings) {
      fetchRecentReadings();
    }
  };

  const getStatusClass = (status) => {
    switch (status) {
      case 'low':
        return 'bs-status-low';
      case 'high':
        return 'bs-status-high';
      case 'normal':
        return 'bs-status-normal';
      default:
        return '';
    }
  };

  // CRITICAL FIX: Render inputs conditionally based on standalone mode
  const renderFormInputs = () => (
    <>
      <div className="bs-input-group">
        {standalone && <label htmlFor="bloodSugar">Blood Sugar Level:</label>}
        <div className="bs-input-with-unit">
          <input
            id="bloodSugar"
            type="number"
            step={unit === 'mmol/L' ? '0.1' : '1'}
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleBlur}
            placeholder={`Enter blood sugar level in ${unit}`}
            required={standalone}
            disabled={disabled || isLoading}
          />
          <select
            value={unit}
            onChange={(e) => {
              const newUnit = e.target.value;
              if (localValue && !isNaN(parseFloat(localValue))) {
                if (newUnit === 'mg/dL' && unit === 'mmol/L') {
                  const converted = mmolToMgdl(parseFloat(localValue)).toString();
                  setLocalValue(converted);
                  if (onBloodSugarChange) {
                    const utcTimestamp = TimeManager.localToUTCISOString(readingTime);
                    onBloodSugarChange(parseFloat(converted), utcTimestamp);
                  }
                } else if (newUnit === 'mmol/L' && unit === 'mg/dL') {
                  const mmolValue = mgdlToMmol(parseFloat(localValue));
                  setLocalValue(mmolValue);
                  if (onBloodSugarChange) {
                    const utcTimestamp = TimeManager.localToUTCISOString(readingTime);
                    onBloodSugarChange(mmolToMgdl(parseFloat(mmolValue)), utcTimestamp);
                  }
                }
              }
              setUnit(newUnit);
              if (recentReadings.length > 0) {
                setRecentReadings(readings => readings.map(reading => ({
                  ...reading,
                  displayValue: newUnit === 'mmol/L'
                    ? mgdlToMmol(reading.bloodSugar)
                    : reading.bloodSugar.toFixed(0),
                  displayUnit: newUnit
                })));
              }
            }}
            className="bs-unit-selector"
            disabled={disabled || isLoading}
          >
            <option value="mg/dL">mg/dL</option>
            <option value="mmol/L">mmol/L</option>
          </select>
        </div>
      </div>

      <div className="bs-input-group">
        <label htmlFor="readingTime">Reading Time:</label>
        <TimeInput
          mode="timepoint"
          value={readingTime}
          onChange={handleReadingTimeChange}
          className="bs-time-input-field"
          disabled={disabled || isLoading}
          required={standalone}
        />
      </div>

      {standalone && (
        <div className="bs-input-group">
          <label htmlFor="notes">Notes:</label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add any notes about this reading"
            className="bs-notes-input"
            disabled={disabled || isLoading}
          />
        </div>
      )}

      {standalone && (
        <button type="submit" disabled={disabled || isLoading} className="bs-submit-button">
          {isLoading ? 'Recording...' : 'Record'}
        </button>
      )}
    </>
  );

  return (
    <div className={`bs-container ${className}`}>
      {standalone && (
        <div className="bs-header">
          <h2>Record Blood Sugar Level</h2>
          <div className="bs-action-buttons">
            <button
              type="button"
              className="bs-icon-button bs-refresh-btn"
              onClick={fetchRecentReadings}
              title="Refresh readings"
              disabled={isLoading}
            >
              <FaSync className={isLoading ? "bs-spin" : ""} />
            </button>
            <button
              type="button"
              className="bs-icon-button bs-history-btn"
              onClick={toggleRecentReadings}
              title={showRecentReadings ? "Hide recent readings" : "Show recent readings"}
            >
              <FaHistory />
            </button>
            <button
              type="button"
              className="bs-icon-button bs-import-btn"
              onClick={handleImportClick}
              title="Import blood sugar data"
              disabled={isLoading}
            >
              <FaFileImport />
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept=".csv,.json"
              onChange={handleFileUpload}
            />
          </div>
        </div>
      )}

      {/* CRITICAL FIX: Conditional form wrapper */}
      {standalone ? (
        <form onSubmit={handleSubmit}>
          {renderFormInputs()}
        </form>
      ) : (
        // Non-standalone: render inputs without form wrapper
        <div className="bs-embedded">
          {renderFormInputs()}
        </div>
      )}

      {status.message && (
        <div className={`bs-message ${status.type === 'error' ? 'bs-error' : 'bs-success'}`}>
          {status.message}
        </div>
      )}

      {importStatus && importStatus.message && (
        <div className={`bs-message bs-import-message ${importStatus.type === 'error' ? 'bs-error' : importStatus.type === 'success' ? 'bs-success' : 'bs-info'}`}>
          <div className="bs-import-message-header">
            <FaInfoCircle className="bs-message-icon" />
            <span>{importStatus.message}</span>
          </div>
          {importStatus.details && (
            <div className="bs-import-details">
              {importStatus.details}
            </div>
          )}
        </div>
      )}

      {standalone && showRecentReadings && (
        <div className="bs-recent-readings">
          <h3>Recent Readings</h3>
          {recentReadings.length > 0 ? (
            <div className="bs-readings-list">
              {recentReadings.map((reading, index) => (
                <div key={reading._id || index} className="bs-reading-item">
                  <div className={`bs-reading-value ${getStatusClass(reading.status)}`}>
                    {reading.displayValue} {reading.displayUnit}
                  </div>
                  <div className="bs-reading-details">
                    <span className="bs-reading-time">
                      {new Date(reading.readingTime).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short'
                      })}
                    </span>
                    {reading.notes && (
                      <span className="bs-reading-notes">{reading.notes}</span>
                    )}
                  </div>
                  <div className={`bs-reading-status ${getStatusClass(reading.status)}`}>
                    {reading.status}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="bs-no-readings">{isLoading ? 'Loading...' : 'No recent readings found'}</p>
          )}
          <div className="bs-readings-footer">
            <span className="bs-import-note">
              Need to import multiple readings? Click the <FaFileImport className="bs-inline-icon" /> import button above.
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default BloodSugarInput;





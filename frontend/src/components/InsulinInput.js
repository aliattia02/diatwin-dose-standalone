import API_BASE_URL from '../config';
import React, { useState, useEffect, useRef, useContext } from 'react';
import axios from 'axios';
import { useConstants } from '../contexts/ConstantsContext';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import TimeContext from '../contexts/TimeContext';
import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { getInsulinProfile } from '../utils/insulinPharmacodynamics';
import './Charts/input-components.css';
import { FaInfoCircle, FaChevronDown, FaChevronUp, FaClock, FaFileImport, FaSync, FaHistory } from 'react-icons/fa';
import TimeInput from './TimeInput';
import TimeManager from '../utils/TimeManager';

// ============================================================================
// DEBUG CONTROL - SET TO FALSE IN PRODUCTION
// ============================================================================
const DEBUG_ACTIVE_EFFECTS = false; // Set to true to enable activeEffects logging

const InsulinInput = ({
  onInsulinChange,
  initialInsulin = '',
  initialDose = '',
  isStandalone = true,
  onDoseLogged = null,
  suggestedInsulin = null,
  suggestedInsulinType = null,
  className = ''
}) => {
  const timeContext = useContext(TimeContext);
  const useTimeContextFunctions = !!timeContext;

  const getCurrentTime = () => {
    return useTimeContextFunctions
      ? timeContext.TimeManager.getCurrentTimeISOString()
      : TimeManager.getCurrentTimeISOString();
  };

  const formatDateTime = (timestamp, format) => {
    return useTimeContextFunctions
      ? timeContext.formatDateTime(timestamp, format || timeContext.formats.DATETIME_DISPLAY)
      : TimeManager.formatDateTime(timestamp);
  };

  const formatRelativeTime = (timestamp) => {
    return useTimeContextFunctions
      ? timeContext.TimeManager.formatRelativeTime(timestamp)
      : TimeManager.formatRelativeTime(timestamp);
  };

  const formatTime = (timestamp) => {
    return useTimeContextFunctions
      ? timeContext.TimeManager.formatTime(timestamp)
      : TimeManager.formatTime(timestamp);
  };

  const localToUTC = (localTime) => {
    return useTimeContextFunctions
      ? timeContext.TimeManager.localToUTCISOString(localTime)
      : TimeManager.localToUTCISOString(localTime);
  };

  const parseTimestamp = (timestamp) => {
    return useTimeContextFunctions
      ? timeContext.TimeManager.parseTimestamp(timestamp)
      : TimeManager.parseTimestamp(timestamp);
  };

  const { patientConstants, refreshConstants, loading, error } = useConstants();
  const { activeEffects } = useBloodSugarData();

  const [selectedInsulin, setSelectedInsulin] = useState(initialInsulin);
  const [dose, setDose] = useState(initialDose);
  const [scheduledTime, setScheduledTime] = useState(getCurrentTime());
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentDoses, setRecentDoses] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [insulinsByCategory, setInsulinsByCategory] = useState({});
  const [isLoadingDoses, setIsLoadingDoses] = useState(false);
  const [showRecentDoses, setShowRecentDoses] = useState(false);
  const [importStatus, setImportStatus] = useState(null);

  // ✅ FIX: Remove excessive logging - only log when DEBUG is enabled
  useEffect(() => {
    if (DEBUG_ACTIVE_EFFECTS && activeEffects) {
      console.log('InsulinInput - activeEffects from context:', activeEffects);
    }
  }, [activeEffects]);

  const fileInputRef = useRef(null);

  /**
   * Format insulin name for display
   */
  const formatInsulinName = (insulinType) => {
    // Handle undefined/null values
    if (!insulinType || typeof insulinType !== 'string') {
      return 'Unknown Insulin';
    }

    const profile = getInsulinProfile(insulinType);
    if (profile && profile.brand_names && profile.brand_names.length > 0) {
      return `${profile.brand_names[0]} (${profile.name || insulinType})`;
    }
    return insulinType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  /**
   * Get available insulin types from patient constants
   */
  const getAvailableInsulinTypes = (constants) => {
    if (!constants || !constants.medication_factors) {
      return [];
    }

    return Object.entries(constants.medication_factors)
      .filter(([key, value]) => value.type && value.type.includes('acting'))
      .map(([key, value]) => ({
        id: key,
        name: value.brand_names?.[0] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        type: value.type,
        ...value
      }));
  };

  /**
   * Group insulin types by category (rapid, short, intermediate, long)
   */
  const getInsulinTypesByCategory = (constants) => {
    const insulinTypes = getAvailableInsulinTypes(constants);
    const categories = {
      ultra_rapid: [],
      rapid: [],
      short: [],
      intermediate: [],
      long: [],
      ultra_long: [],
      mixed: []
    };

    insulinTypes.forEach(insulin => {
      if (insulin.type === 'ultra_rapid') {
        categories.ultra_rapid.push(insulin);
      } else if (insulin.type === 'rapid_acting') {
        categories.rapid.push(insulin);
      } else if (insulin.type === 'short_acting') {
        categories.short.push(insulin);
      } else if (insulin.type === 'intermediate_acting') {
        categories.intermediate.push(insulin);
      } else if (insulin.type === 'long_acting') {
        categories.long.push(insulin);
      } else if (insulin.type === 'ultra_long') {
        categories.ultra_long.push(insulin);
      } else if (insulin.type === 'mixed') {
        categories.mixed.push(insulin);
      }
    });

    // Remove empty categories
    Object.keys(categories).forEach(key => {
      if (categories[key].length === 0) {
        delete categories[key];
      }
    });

    return categories;
  };

  /**
   * Calculate active status for a dose
   */
  const calculateActiveStatus = (dose) => {
    const now = parseTimestamp(
      useTimeContextFunctions ? timeContext.systemDateTime : TimeManager.getSystemDateTime()
    );

    if (!dose.effect_start_time || !dose.effect_end_time) {
      return "Unknown status";
    }

    const effectStart = parseTimestamp(dose.effect_start_time);
    const onsetTime = dose.onset_time ? parseTimestamp(dose.onset_time) : null;
    const peakTime = dose.peak_time ? parseTimestamp(dose.peak_time) : null;
    const effectEnd = parseTimestamp(dose.effect_end_time);

    if (now < effectStart) {
      return "Not yet active";
    } else if (onsetTime && now < onsetTime) {
      return "Starting to work";
    } else if (peakTime && now < peakTime) {
      return "Approaching peak";
    } else if (now < effectEnd) {
      return "Active and decreasing";
    } else {
      return "Completed";
    }
  };

  useEffect(() => {
    setInsulinsByCategory(getInsulinTypesByCategory(patientConstants));
  }, [patientConstants]);

  useEffect(() => {
    setScheduledTime(getCurrentTime());
    setSelectedInsulin(initialInsulin);
    setDose(initialDose);

    if (isStandalone) {
      fetchRecentDoses();
    }
  }, [initialInsulin, initialDose, isStandalone]);

  const fetchRecentDoses = async () => {
    try {
      setIsLoadingDoses(true);
      const token = localStorage.getItem('token');
      if (!token) {
        console.log('No authentication token found for fetching recent doses');
        return;
      }

      const response = await axios.get(
        `${API_BASE_URL}/api/medication-logs/recent`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          params: {
            medication_type: 'insulin',
            limit: 5
          }
        }
      );

      if (response.data && response.data.logs) {
        const processedDoses = response.data.logs.map(dose => {
          const scheduledTime = dose.scheduled_time || dose.taken_at;
          const takenAt = dose.taken_at || dose.scheduled_time;

          return {
            ...dose,
            scheduled_time: scheduledTime,
            taken_at: takenAt,
            scheduled_time_date: parseTimestamp(scheduledTime),
            taken_at_date: parseTimestamp(takenAt)
          };
        });

        setRecentDoses(processedDoses);
      }
    } catch (err) {
      console.error('Error fetching recent doses:', err);
      setMessage('Failed to load recent insulin doses');
    } finally {
      setIsLoadingDoses(false);
    }
  };

  const handleDoseChange = (e) => {
    const value = e.target.value;
    if (!isNaN(value) && (value === '' || parseFloat(value) >= 0)) {
      setDose(value);

      if (!isStandalone && onInsulinChange) {
        onInsulinChange({
          type: selectedInsulin,
          dose: value,
          notes: notes,
          administrationTime: scheduledTime
        });
      }
    }
  };

  const handleInsulinTypeChange = (e) => {
    setSelectedInsulin(e.target.value);
    setDetailsExpanded(false);

    if (!isStandalone && onInsulinChange) {
      onInsulinChange({
        type: e.target.value,
        dose: dose,
        notes: notes,
        administrationTime: scheduledTime
      });
    }
  };

  const handleNotesChange = (e) => {
    setNotes(e.target.value);

    if (!isStandalone && onInsulinChange) {
      onInsulinChange({
        type: selectedInsulin,
        dose: dose,
        notes: e.target.value,
        administrationTime: scheduledTime
      });
    }
  };

  const handleTimeChange = (newTime) => {
    setScheduledTime(newTime);

    if (!isStandalone && onInsulinChange) {
      onInsulinChange({
        type: selectedInsulin,
        dose: dose,
        notes: notes,
        administrationTime: newTime
      });
    }
  };

  const toggleDetails = () => {
    setDetailsExpanded(!detailsExpanded);
  };

  const toggleExpanded = () => {
    setExpanded(!expanded);
  };

  const toggleRecentDoses = () => {
    setShowRecentDoses(prev => !prev);
    if (!showRecentDoses) {
      fetchRecentDoses();
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

    setIsSubmitting(true);
    setImportStatus({ type: 'info', message: 'Validating file...' });

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'insulin');

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
        setIsSubmitting(false);
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
        message: `Successfully imported ${results.insulin_imported || 0} insulin doses`,
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      await fetchRecentDoses();
      await refreshConstants();

    } catch (error) {
      console.error('Error importing data:', error);
      setImportStatus({
        type: 'error',
        message: 'Failed to import data',
        details: error.response?.data?.error || error.message || 'Unknown error occurred'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    if (!isStandalone) {
      if (onInsulinChange) {
        onInsulinChange({
          type: selectedInsulin,
          dose: dose,
          notes: notes,
          administrationTime: scheduledTime
        });
      }
      return;
    }

    try {
      setIsSubmitting(true);
      setMessage('');

      if (!selectedInsulin) {
        throw new Error('Please select an insulin type');
      }
      if (!dose || parseFloat(dose) <= 0) {
        throw new Error('Please enter a valid dose');
      }

      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Session token not found. Please log in again.');
      }

      const utcScheduledTime = localToUTC(scheduledTime);

      const response = await axios.post(
        `${API_BASE_URL}/api/meal`,
        {
          mealType: 'insulin_only',
          recordingType: 'insulin',
          foodItems: [],
          activities: [],
          bloodSugar: null,
          bloodSugarSource: 'none',
          intendedInsulin: parseFloat(dose),
          intendedInsulinType: selectedInsulin,
          notes: notes,
          medicationLog: {
            is_insulin: true,
            dose: parseFloat(dose),
            medication: selectedInsulin,
            scheduled_time: utcScheduledTime,
            notes: notes
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.status === 201 || response.status === 200) {
        setMessage('Insulin dose logged successfully');

        await fetchRecentDoses();
        await refreshConstants();

        setSelectedInsulin('');
        setDose('');
        setNotes('');
        setExpanded(false);
        setScheduledTime(getCurrentTime());

        if (onDoseLogged) {
          onDoseLogged(response.data);
        }
      }
    } catch (err) {
      let errorMessage = 'An error occurred while recording insulin dose';

      if (err.response?.data?.error) {
        errorMessage = err.response.data.error;
      } else if (err.response?.data?.message) {
        errorMessage = err.response.data.message;
      } else if (err.message) {
        errorMessage = err.message;
      }

      setMessage(`Error: ${errorMessage}`);
      console.error('Error submitting insulin dose:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="insulin-loading">Loading insulin options...</div>;
  }

  if (error) {
    return <div className="insulin-error">Error: {error}</div>;
  }

  return (
    <div className={`insulin-container ${isStandalone ? 'insulin-standalone' : ''} ${className}`}>
      {isStandalone && (
        <div className="insulin-header">
          <h3 className="insulin-title">Record Insulin</h3>
          <div className="insulin-action-buttons">
            <button
              type="button"
              className="insulin-icon-button insulin-refresh-btn"
              onClick={fetchRecentDoses}
              title="Refresh insulin doses"
              disabled={isSubmitting}
            >
              <FaSync className={isLoadingDoses ? "insulin-spinning" : ""} />
            </button>
            <button
              type="button"
              className="insulin-icon-button insulin-history-btn"
              onClick={toggleRecentDoses}
              title={showRecentDoses ? "Hide recent doses" : "Show recent doses"}
            >
              <FaHistory />
            </button>
            <button
              type="button"
              className="insulin-icon-button insulin-import-btn"
              onClick={handleImportClick}
              title="Import insulin doses"
              disabled={isSubmitting}
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

      {importStatus && (
        <div className={`insulin-message insulin-msg-${importStatus.type}`}>
          <FaInfoCircle className="insulin-message-icon" />
          <div className="insulin-message-content">
            <h4>{importStatus.message}</h4>
            {importStatus.details && (
              <pre className="insulin-message-details">{importStatus.details}</pre>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {!isStandalone && suggestedInsulin !== null && (
          <div className="insulin-suggested">
            <p>Suggested: {suggestedInsulin} units of {formatInsulinName(suggestedInsulinType)}</p>
          </div>
        )}

        <div className="insulin-input-group">
          <label htmlFor="insulinType" className="insulin-input-label">Insulin Type</label>
          <div className="insulin-select-container">
            <select
              id="insulinType"
              value={selectedInsulin}
              onChange={handleInsulinTypeChange}
              className="insulin-type-select"
              required
            >
              <option value="">Select insulin type</option>

              {Object.entries(insulinsByCategory).map(([category, insulins]) => {
                const categoryLabels = {
                  ultra_rapid: 'Ultra Rapid Acting',
                  rapid: 'Rapid Acting',
                  short: 'Short Acting',
                  intermediate: 'Intermediate Acting',
                  long: 'Long Acting',
                  ultra_long: 'Ultra Long Acting',
                  mixed: 'Mixed/Combination'
                };

                return (
                  <optgroup key={category} label={categoryLabels[category] || category}>
                    {insulins.map(insulin => (
                      <option key={insulin.id} value={insulin.id}>
                        {insulin.name} {insulin.brand_names && insulin.brand_names.length > 0 && `(${insulin.brand_names[0]})`}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
        </div>

        <div className="insulin-input-group">
          <label htmlFor="insulinDose" className="insulin-input-label">
            {isStandalone ? 'Insulin Dose (units)' : 'Intended Insulin Intake (units)'}
          </label>
          <input
            id="insulinDose"
            type="number"
            min="0"
            step="0.5"
            value={dose}
            onChange={handleDoseChange}
            className="insulin-dose-input"
            required={isStandalone}
          />
        </div>

        <div className="insulin-collapsible-section">
          <button
            type="button"
            onClick={toggleExpanded}
            className="insulin-collapsible-toggle"
          >
            <span>Time & Notes</span>
            {expanded ? <FaChevronUp /> : <FaChevronDown />}
          </button>

          {expanded && (
            <div className="insulin-collapsible-content">
              <div className="insulin-input-group">
                <label htmlFor="administrationTime" className="insulin-input-label">
                  <FaClock className="insulin-time-icon" /> Administration Time
                </label>
                <TimeInput
                  mode="timepoint"
                  value={scheduledTime}
                  onChange={handleTimeChange}
                  className="insulin-time-input"
                  required={isStandalone}
                  useTimeContext={useTimeContextFunctions}
                />
              </div>

              <div className="insulin-notes-container">
                <label htmlFor="insulinNotes" className="insulin-input-label">Notes</label>
                <textarea
                  id="insulinNotes"
                  value={notes}
                  onChange={handleNotesChange}
                  placeholder="Add any notes about this insulin dose"
                  className="insulin-notes-input"
                />
              </div>
            </div>
          )}
        </div>

        {/* ✅ FIX: Proper HTML structure - removed nested divs that could cause nesting errors */}
        {activeEffects?.iob && activeEffects.iob.total_active_insulin > 0 && (
          <div className="insulin-active-section">
            <h4>
              Active Insulin: {activeEffects.iob.total_active_insulin.toFixed(2)} units
              {activeEffects.calculation_time && (
                <span className="insulin-calculation-time">
                  {' '}(as of {formatDateTime(new Date(activeEffects.calculation_time))})
                </span>
              )}
            </h4>
            {activeEffects.iob.insulin_contributions && activeEffects.iob.insulin_contributions.length > 0 && (
              <div className="insulin-contributions-list">
                {activeEffects.iob.insulin_contributions.map((contrib, idx) => {
                  // Handle both old (insulinType) and new (medication) field names
                  const insulinName = contrib.medication || contrib.insulinType;
                  const activeUnits = contrib.activeUnits || contrib.active_units || contrib.iob || 0;
                  const hoursSince = contrib.hoursSinceDose || contrib.hours_since_dose || 0;
                  const activityPct = contrib.activityPercent || contrib.activity_percent || contrib.activity || 0;
                  const doseAmount = contrib.dose || contrib.initial_dose || 0;

                  return (
                    <div key={idx} className="insulin-contribution-item">
                      <span className="insulin-contribution-medication">
                        {formatInsulinName(insulinName)}
                      </span>
                      <span className="insulin-contribution-details">
                        {doseAmount} units, {activeUnits.toFixed(2)} active
                      </span>
                      <div className="insulin-contribution-time">
                        {hoursSince.toFixed(1)}h ago ({Math.round(activityPct)}% active)
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {activeEffects.stacking?.is_stacking && (
              <div className={`insulin-stacking-warning insulin-stacking-${activeEffects.stacking.risk_level}`}>
                ⚠️ Insulin stacking detected - Risk level: {activeEffects.stacking.risk_level}
              </div>
            )}
          </div>
        )}

      {selectedInsulin && patientConstants?.medication_factors?.[selectedInsulin] && (
          <div className="insulin-info-section">
            <button
              className="insulin-info-toggle"
              onClick={toggleDetails}
              type="button"
            >
              {detailsExpanded ? 'Hide Details' : 'Show Details'}
              {detailsExpanded ? <FaChevronUp className="insulin-toggle-icon" /> : <FaChevronDown className="insulin-toggle-icon" />}
            </button>

            {detailsExpanded && (
              <div className="insulin-expanded-info">
                <div className="insulin-info-grid">
                  <div className="insulin-info-item">
                    <span className="insulin-info-item-label">Onset:</span>
                    <span className="insulin-info-item-value">{patientConstants.medication_factors[selectedInsulin].onset_hours} hours</span>
                  </div>
                  <div className="insulin-info-item">
                    <span className="insulin-info-item-label">Peak:</span>
                    <span className="insulin-info-item-value">
                      {patientConstants.medication_factors[selectedInsulin].is_peakless
                        ? 'Peakless'
                        : `${patientConstants.medication_factors[selectedInsulin].peak_hours} hours`}
                    </span>
                  </div>
                  <div className="insulin-info-item">
                    <span className="insulin-info-item-label">Duration:</span>
                    <span className="insulin-info-item-value">{patientConstants.medication_factors[selectedInsulin].duration_hours} hours</span>
                  </div>
                  <div className="insulin-info-item">
                    <span className="insulin-info-item-label">Type:</span>
                    <span className="insulin-info-item-value">
                      {patientConstants.medication_factors[selectedInsulin].type.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>

                {patientConstants.medication_factors[selectedInsulin].brand_names && (
                  <div className="insulin-brand-names">
                    <span className="insulin-info-item-label">Brand Names:</span>
                    <span className="insulin-info-item-value">
                      {patientConstants.medication_factors[selectedInsulin].brand_names.join(', ')}
                    </span>
                  </div>
                )}

                <p className="insulin-description">
                  {patientConstants.medication_factors[selectedInsulin].description}
                </p>

                {!patientConstants.medication_factors[selectedInsulin].is_peakless && (
                  <div className="insulin-timeline-section">
                    <div className="insulin-timeline-bar">
                      <div
                        className="insulin-onset-marker"
                        style={{left: `${(patientConstants.medication_factors[selectedInsulin].onset_hours / patientConstants.medication_factors[selectedInsulin].duration_hours) * 100}%`}}
                      >
                        <span>Onset</span>
                      </div>
                      <div
                        className="insulin-peak-marker"
                        style={{left: `${(patientConstants.medication_factors[selectedInsulin].peak_hours / patientConstants.medication_factors[selectedInsulin].duration_hours) * 100}%`}}
                      >
                        <span>Peak</span>
                      </div>
                      <div className="insulin-duration-line"></div>
                    </div>
                    <div className="insulin-timeline-labels">
                      <span>0h</span>
                      <span>{patientConstants.medication_factors[selectedInsulin].duration_hours}h</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {message && (
          <div className={`insulin-message ${message.includes('Error') ? 'insulin-msg-error' : 'insulin-msg-success'}`}>
            {message}
          </div>
        )}

        {isStandalone && (
          <button
            type="submit"
            className="insulin-submit-button"
            disabled={isSubmitting || !selectedInsulin || !dose}
          >
            {isSubmitting ? 'Recording...' : 'Record Insulin Dose'}
          </button>
        )}
      </form>

      {isStandalone && showRecentDoses && (
        <div className="insulin-recent-doses-section">
          <h4>Recent Insulin Doses</h4>
          {isLoadingDoses ? (
            <div className="insulin-loading-doses">Loading recent doses...</div>
          ) : recentDoses.length > 0 ? (
            <div className="insulin-doses-list">
              {recentDoses.map((dose, index) => (
                <div key={index} className="insulin-dose-item">
                  <div className="insulin-dose-header">
                    <span className="insulin-dose-type">
                      {formatInsulinName(dose.medication)}
                    </span>
                    <span className="insulin-dose-amount">
                      {dose.dose} units
                    </span>
                  </div>
                  <div className="insulin-dose-details-section">
                    <span className="insulin-dose-time">
                      {formatDateTime(dose.taken_at_date || dose.taken_at || dose.scheduled_time)}
                    </span>
                    {dose.effect_end_time && (
                      <span className="insulin-dose-activity-status">
                        {calculateActiveStatus(dose)}
                        {parseTimestamp(
                          useTimeContextFunctions ? timeContext.systemDateTime : TimeManager.getSystemDateTime()
                        ) < parseTimestamp(dose.effect_end_time) ?
                          ` (Active until ${formatTime(dose.effect_end_time)})` :
                          " (Inactive)"}
                      </span>
                    )}
                    {dose.notes && (
                      <span className="insulin-dose-notes">{dose.notes}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="insulin-no-doses">No recent insulin doses found</p>
          )}
          <div className="insulin-doses-footer">
            <span className="insulin-import-note">
              Need to import multiple doses? Click the <FaFileImport className="insulin-inline-icon" /> import button above.
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default InsulinInput;





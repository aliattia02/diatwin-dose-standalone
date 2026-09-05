import API_BASE_URL from '../config';
import React, { createContext, useState, useContext, useCallback, useEffect } from 'react';
import { DEFAULT_PATIENT_CONSTANTS } from '../constants';
import axios from 'axios';

const ConstantsContext = createContext();

export function ConstantsProvider({ children }) {
  const [patientConstants, setPatientConstants] = useState(DEFAULT_PATIENT_CONSTANTS);
  const [medicationSchedules, setMedicationSchedules] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPatientConstants = async (skipTokenCheck = false) => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      if (!token && !skipTokenCheck) {
        setPatientConstants(DEFAULT_PATIENT_CONSTANTS);
        return;
      }

      if (!token) {
        throw new Error('No authentication token found');
      }

      const response = await axios.get(`${API_BASE_URL}/api/patient/constants`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const constants = response.data.constants;
      if (!constants) {
        console.warn('No constants received from server, using defaults');
        setPatientConstants(DEFAULT_PATIENT_CONSTANTS);
        setError(null);
        return;
      }

      // Merge with defaults and set state
      setPatientConstants({
        ...DEFAULT_PATIENT_CONSTANTS,
        ...constants,
        disease_factors: constants.disease_factors || DEFAULT_PATIENT_CONSTANTS.disease_factors,
        medication_factors: constants.medication_factors || DEFAULT_PATIENT_CONSTANTS.medication_factors,
        active_conditions: constants.active_conditions || [],
        active_medications: constants.active_medications || [],
        medication_schedules: constants.medication_schedules || {}
      });
      setError(null);

    } catch (error) {
      console.error('Error fetching patient constants:', error);
      setPatientConstants(DEFAULT_PATIENT_CONSTANTS);
      if (error.message !== 'No authentication token found') {
        setError(error.response?.data?.error || error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // Only fetch constants when there's a token
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      fetchPatientConstants();
    } else {
      setPatientConstants(DEFAULT_PATIENT_CONSTANTS);
      setLoading(false);
    }
  }, []);

  const refreshConstants = useCallback(() => {
    const token = localStorage.getItem('token');
    if (token) {
      return fetchPatientConstants();
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchPatientConstants();
  }, []);


  const fetchMedicationSchedules = async (patientId) => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      if (!token) throw new Error('No authentication token found');

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
        const schedulesMap = response.data.schedules.reduce((acc, schedule) => {
          acc[schedule.medication] = schedule;
          return acc;
        }, {});

        setMedicationSchedules(schedulesMap);

        // Update patient constants with medication schedules
        setPatientConstants(prev => ({
          ...prev,
          medication_schedules: schedulesMap
        }));
      }
    } catch (error) {
      console.error('Error fetching medication schedules:', error);
      setError('Failed to fetch medication schedules');
    } finally {
      setLoading(false);
    }
  };

  const updateMedicationSchedule = async (patientId, medication, scheduleData) => {
    try {
      setLoading(true);
      setError(null);

      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('No authentication token found');
      }

      // Ensure scheduleData is properly formatted
      const formattedSchedule = {
        startDate: new Date(scheduleData.startDate).toISOString(),
        endDate: new Date(scheduleData.endDate).toISOString(),
        dailyTimes: scheduleData.dailyTimes
      };

      const response = await axios({
        method: 'post',
        url: `${API_BASE_URL}/api/medication-schedule/${patientId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        data: {
          medication,
          schedule: formattedSchedule
        }
      });

      if (response.data.schedule) {
        // Update local state with the new schedule
        setMedicationSchedules(prev => ({
          ...prev,
          [medication]: response.data.schedule
        }));

        // Update patient constants
        setPatientConstants(prev => ({
          ...prev,
          medication_schedules: {
            ...(prev.medication_schedules || {}),
            [medication]: response.data.schedule
          }
        }));

        return response.data.schedule;
      }
    } catch (error) {
      console.error('Error updating medication schedule:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const deleteMedicationSchedule = async (patientId, medication) => {
    try {
      setLoading(true);
      setError(null);

      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('No authentication token found');
      }

      const response = await axios({
        method: 'delete',
        url: `${API_BASE_URL}/api/medication-schedule/${patientId}/${medication}`,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 200) {
        // Remove schedule from local state
        setMedicationSchedules(prev => {
          const updated = { ...prev };
          delete updated[medication];
          return updated;
        });

        // Remove from patient constants
        setPatientConstants(prev => {
          const updatedSchedules = { ...prev.medication_schedules };
          delete updatedSchedules[medication];
          return {
            ...prev,
            medication_schedules: updatedSchedules
          };
        });
      }
    } catch (error) {
      console.error('Error deleting medication schedule:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };



  // Initial fetch of constants
  useEffect(() => {
    refreshConstants();
  }, [refreshConstants]);

  // Event listener for medication schedule updates
  useEffect(() => {
    const handleScheduleUpdate = (event) => {
      const { medication, schedule } = event.detail;
      setMedicationSchedules(prev => ({
        ...prev,
        [medication]: schedule
      }));

      setPatientConstants(prev => ({
        ...prev,
        medication_schedules: {
          ...(prev.medication_schedules || {}),
          [medication]: schedule
        }
      }));
    };

    window.addEventListener('medicationScheduleUpdated', handleScheduleUpdate);
    return () => {
      window.removeEventListener('medicationScheduleUpdated', handleScheduleUpdate);
    };
  }, []);

  const contextValue = {
    patientConstants,
    medicationSchedules,
    loading,
    error,
    refreshConstants,
    setPatientConstants,
    updateMedicationSchedule,
    deleteMedicationSchedule,
    fetchMedicationSchedules
  };

  return (
    <ConstantsContext.Provider value={contextValue}>
      {children}
    </ConstantsContext.Provider>
  );
}

// Custom hook to use the constants context
export function useConstants() {
  const context = useContext(ConstantsContext);
  if (!context) {
    throw new Error('useConstants must be used within a ConstantsProvider');
  }
  return context;
}

export default ConstantsContext;





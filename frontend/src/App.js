import API_BASE_URL from './config';
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, useParams } from 'react-router-dom';
import SignIn from './components/SignIn';
import Register from './components/Register';
import PatientDashboard from './components/PatientDashboard';
import DoctorDashboard from './components/DoctorDashboard';
import AdminDashboard from './components/AdminDashboard';
import { ConstantsProvider } from './contexts/ConstantsContext';
import { BloodSugarDataProvider } from './contexts/BloodSugarDataContext';
import { TimeProvider } from './contexts/TimeContext';
import { LibreProvider } from './contexts/LibreContext';
import MealHistory from './components/MealHistory';
import TimeManager from './utils/TimeManager';
import axios from 'axios';
import './App.css';

// D25: both meal-history routes used to render GlycemicResponseTracker, which
// was a 0-byte module — the route threw at render rather than showing anything.
// MealHistory is the working component for the same data, and it takes the
// patient id as a prop, so the doctor route reads it off the URL instead of
// leaving it null the way the old route did.
function PatientMealHistory() {
  const { patientId } = useParams();
  return <MealHistory isDoctor={true} patientId={patientId} />;
}

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userType, setUserType] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const storedUserType = localStorage.getItem('userType');
    if (token && storedUserType) {
      setLoggedIn(true);
      setUserType(storedUserType);
    }
  }, []);

  // 🆕 TIMEZONE INITIALIZATION - Auto-save timezone when app loads
  useEffect(() => {
    const initializeTimezone = async () => {
      const token = localStorage.getItem('token');
      if (!token || !loggedIn) return;

      try {
        // Get current browser timezone
        const tzInfo = TimeManager.getTimezoneInfo();
        console.log('🌐 Browser timezone detected:', tzInfo);

        // Create axios instance with auth header
        const api = axios.create({
          baseURL: `${API_BASE_URL}`,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        // Fetch current patient constants to check if timezone is set
        const response = await api.get('/api/patient/constants');
        const savedTimezone = response.data.constants?.timezone_offset_minutes;

        // Check if timezone needs updating
        const currentTimezone = tzInfo.offset_minutes;

        if (savedTimezone === undefined || savedTimezone !== currentTimezone) {
          console.log(`⚠️ Timezone mismatch or not set. Saved: ${savedTimezone}, Current: ${currentTimezone}`);

          // Save current timezone to backend
          await api.patch('/api/patient/constants', {
            timezone_offset_minutes: currentTimezone
          });

          console.log('✅ Timezone saved successfully:', TimeManager.getTimezoneString());
        } else {
          console.log('✅ Timezone already up to date:', TimeManager.getTimezoneString());
        }
      } catch (error) {
        console.error('❌ Failed to initialize timezone:', error);
        // Don't throw - let app continue even if timezone save fails
      }
    };

    initializeTimezone();

    // Optional: Check timezone daily (for DST changes or travel)
    const dailyCheck = setInterval(initializeTimezone, 24 * 60 * 60 * 1000);
    return () => clearInterval(dailyCheck);
  }, [loggedIn]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userType');
    localStorage.removeItem('firstName');
    localStorage.removeItem('lastName');
    setLoggedIn(false);
    setUserType(null);
  };

  const renderDashboard = () => {
    switch (userType) {
      case 'patient':
        return <PatientDashboard handleLogout={handleLogout} />;
      case 'doctor':
        return <DoctorDashboard handleLogout={handleLogout} />;
      case 'admin':
        return <AdminDashboard handleLogout={handleLogout} />;
      default:
        return <Navigate to="/login" />;
    }
  };

  return (
    <Router>
      <TimeProvider>
        <ConstantsProvider>
          <LibreProvider>
          <BloodSugarDataProvider>
            <div className="App">
              <Routes>
                <Route path="/login" element={
                  loggedIn ? <Navigate to="/dashboard" /> : <SignIn setLoggedIn={setLoggedIn} setUserType={setUserType} />
                } />
                <Route path="/register" element={<Register />} />
                <Route path="/dashboard" element={
                  loggedIn ? renderDashboard() : <Navigate to="/login" />
                } />
                <Route path="/meal-history" element={
                  loggedIn ? <MealHistory /> : <Navigate to="/login" />
                } />
                <Route path="/patient/:patientId/meal-history" element={
                  loggedIn && (userType === 'doctor' || userType === 'admin') ?
                    <PatientMealHistory /> :
                    <Navigate to="/login" />
                } />
                <Route path="/" element={<Navigate to="/login" />} />
              </Routes>
            </div>
          </BloodSugarDataProvider>
          </LibreProvider>
        </ConstantsProvider>
      </TimeProvider>
    </Router>
  );
}

export default App;
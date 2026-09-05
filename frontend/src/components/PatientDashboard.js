import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BloodSugarDataProvider } from '../contexts/BloodSugarDataContext';
import { getLibreStatus } from '../contexts/LibreContext';
import MealInput from './MealInput';
import MealHistory from './MealHistory';
import BloodSugarInput from './BloodSugarInput';
import BloodSugarVisualization from './BloodSugarVisualization';
import InsulinVisualization from './InsulinVisualization';
import CombinedGlucoseInsulinChart from './CombinedGlucoseInsulinChart';
import ActivityRecording from './ActivityRecording';
import ActivityVisualization from './ActivityVisualization';
import GlycemicResponseTracker from './GlycemicResponseTracker';
import MealVisualization from './MealVisualizationmealsonly';
import FoodDatabase from './FoodDatabase';
import PatientConstants from './PatientConstants';
import InsulinInput from './InsulinInput';
import DoctorManagement from './DoctorManagement';
import ActiveEffectsDisplay from './ActiveEffectsDisplay';
import EffectsVisualization from './EffectsVisualization';
import ClinicalValidationDashboard from './ClinicalValidationDashboard';
import CGMMonitoringDashboard from './CGMMonitoringDashboard';
import PureGlucoseVisualization from './PureGlucoseVisualization';
import SMBGMonitoringDashboard from './SMBGMonitoringDashboard';
import TestComponent from './Test';
import './Charts/dashboard-components.css';

const PatientDashboard = ({ handleLogout }) => {
  const [userName, setUserName] = useState('');
  const [activeTab, setActiveTab] = useState('main');
  const [activeComponent, setActiveComponent] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // ── Libre: silently fetch-and-save the latest CGM reading ──────────────
  // Mirrors mobile/app/(app)/(tabs)/index.tsx behaviour:
  //   getLibreStatus(true) tells the backend to pull the most recent sensor
  //   value from LibreLinkUp and persist it to the blood_sugar collection.
  //   BloodSugarDataContext then picks it up on its next minute-tick refresh,
  //   giving ActiveEffectsDisplay an up-to-date anchor reading automatically.
  //   The call is fire-and-forget — a failure never blocks the dashboard.
  const libreIntervalRef = useRef(null);

  useEffect(() => {
    const saveLatestReading = () =>
      getLibreStatus(true).catch(() => { /* non-fatal */ });

    // Run immediately on mount
    saveLatestReading();

    // Then every 5 minutes to match the default LibreLinkUp sync interval
    libreIntervalRef.current = setInterval(saveLatestReading, 5 * 60 * 1000);

    return () => clearInterval(libreIntervalRef.current);
  }, []);
  // ────────────────────────────────────────────────────────────────────────

  const loadUserData = useCallback(async () => {
    try {
      setIsLoading(true);
      const firstName = localStorage.getItem('firstName') || '';
      const lastName = localStorage.getItem('lastName') || '';
      setUserName(`${firstName} ${lastName}`.trim());
    } catch (error) {
      console.error('Error loading user data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const initDashboard = async () => {
      try {
        if (mounted) {
          await loadUserData();
        }
      } catch (error) {
        console.error('Dashboard initialization error:', error);
      }
    };

    initDashboard();

    return () => {
      mounted = false;
    };
  }, [loadUserData]);

  const renderActiveComponent = useCallback(() => {
    if (isLoading || !activeComponent) {
      return null;
    }

    switch (activeComponent) {
      // Meal Management Tab
      case 'MealInput':
        return <MealInput key="meal-input" />;
      case 'SimpleMealEffectChart':
        return <GlycemicResponseTracker key="Meal-Visualization" userType="patient" />;
      case 'FoodDatabase':
        return <FoodDatabase key="food-database" />;
      case 'mealHistory':
        return <MealHistory key="meal-history" />;

      // Analytics Tab
      case 'MealVisualization':
        return <MealVisualization key="Meal-Visualization" userType="patient" />;
      case 'InsulinVisualization':
        return <InsulinVisualization key="insulin-visualization" />;
      case 'EffectsVisualization':
        return <EffectsVisualization key="effects-visualization" />;
      case 'ActivityVisualization':
        return <ActivityVisualization key="activity-visualization" userType="patient" />;

      // Glucose Monitoring Tab
      case 'PureGlucoseVisualization':
        return <PureGlucoseVisualization key="pure-glucose" />;
      case 'BloodSugarVisualization':
        return <BloodSugarVisualization key="blood-sugar-visualization" />;
      case 'CombinedGlucoseInsulinChart':
        return <CombinedGlucoseInsulinChart key="combined-glucose-insulin-chart" />;
      case 'ClinicalValidationDashboard':
        return <ClinicalValidationDashboard key="clinical-validation" />;
      case 'CGMMonitoringDashboard':
        return <CGMMonitoringDashboard key="cgm-monitoring" />;
      case 'SMBGMonitoringDashboard':
        return <SMBGMonitoringDashboard key="smbg-monitoring" />;

      // Settings Tab
      case 'PatientConstants':
        return <PatientConstants key="patient-constants" />;
      case 'DoctorManagement':
        return <DoctorManagement key="doctor-management" />;
      case 'TestComponent':
        return <TestComponent key="test-component" />;

      default:
        return null;
    }
  }, [activeComponent, isLoading]);

  const handleComponentChange = useCallback((componentName) => {
    setActiveComponent(componentName);
  }, []);

  const tabCategories = {
    meals: {
      title: '🍽️ Meal Management',
      items: [
        { name: 'MealInput', label: 'Meal Input' },
        { name: 'SimpleMealEffectChart', label: 'Combined Meal Analytics' },
        { name: 'FoodDatabase', label: 'Meal Management' },
        { name: 'mealHistory', label: 'Meal History' }
      ]
    },
    analytics: {
      title: '📊 Analytics & Visualizations',
      items: [
        { name: 'MealVisualization', label: 'Meal Analytics' },
        { name: 'InsulinVisualization', label: 'Insulin Visualization' },
        { name: 'EffectsVisualization', label: 'Effects Visualization' },
        { name: 'ActivityVisualization', label: 'Activity Visualization' }
      ]
    },
    glucose: {
      title: '🩸 Glucose Monitoring',
      items: [
        { name: 'PureGlucoseVisualization', label: '📈 Pure Glucose Curve' },
        { name: 'BloodSugarVisualization', label: 'Blood Glucose Visualization' },
        { name: 'CombinedGlucoseInsulinChart', label: 'Glucose Insulin Analytics' },
        { name: 'ClinicalValidationDashboard', label: 'Clinical Validation Dashboard' },
        { name: 'CGMMonitoringDashboard', label: 'CGM Monitoring Dashboard' },
        { name: 'SMBGMonitoringDashboard', label: 'SMBG Monitoring Dashboard' }
      ]
    },
    settings: {
      title: '⚙️ Settings & Management',
      items: [
        { name: 'PatientConstants', label: 'Patient Constants' },
        { name: 'DoctorManagement', label: '👨‍⚕️ Manage My Doctors' },
        { name: 'TestComponent', label: '🧪 Test Component' }
      ]
    }
  };

  return (
    <BloodSugarDataProvider>
      <div className="dash-patient-dashboard">
        <header className="dash-patient-dashboard-header">
          <h1 className="dash-patient-welcome-text">
            {isLoading ? 'Loading...' : `Welcome, ${userName}`}
          </h1>
          <button
            onClick={handleLogout}
            className="dash-patient-logout-button"
            disabled={isLoading}
          >
            Logout
          </button>
        </header>

        {!isLoading && (
          <>
            {/* Main Dashboard Components - Always visible */}
            <div className="dash-patient-main-content">
              {/* Active Effects Display (IOB + MOB + Net Effects) */}
              <div className="dash-patient-active-effects-section">
                <ActiveEffectsDisplay
                  compact={false}
                  showDetails={true}
                  refreshInterval={60000}
                />
              </div>

              <div className="dash-patient-two-column-layout">
                <div className="dash-patient-left-column">
                  <div className="dash-patient-dashboard-card">
                    <h2 className="dash-patient-card-title">Meal Input</h2>
                    <MealInput />
                  </div>
                </div>

                <div className="dash-patient-right-column">
                  <div className="dash-patient-dashboard-card">
                    <h2 className="dash-patient-card-title">Blood Glucose Input</h2>
                    <BloodSugarInput />
                  </div>

                  <div className="dash-patient-dashboard-card">
                    <h2 className="dash-patient-card-title">Insulin Recording</h2>
                    <InsulinInput isStandalone={true} />
                  </div>

                  <div className="dash-patient-dashboard-card">
                    <h2 className="dash-patient-card-title">Activity Recording</h2>
                    <ActivityRecording userType="patient" />
                  </div>
                </div>
              </div>
            </div>

            {/* Navigation Tabs - Positioned after main content */}
            <div className="dash-patient-tabs-container">
              <div className="dash-patient-tabs-navigation">
                <button
                  className={`dash-patient-tab-button ${activeTab === 'main' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('main');
                    setActiveComponent(null);
                  }}
                >
                  🏠 Main Dashboard
                </button>
                <button
                  className={`dash-patient-tab-button ${activeTab === 'meals' ? 'active' : ''}`}
                  onClick={() => setActiveTab('meals')}
                >
                  🍽️ Meal Management
                </button>
                <button
                  className={`dash-patient-tab-button ${activeTab === 'analytics' ? 'active' : ''}`}
                  onClick={() => setActiveTab('analytics')}
                >
                  📊 Analytics
                </button>
                <button
                  className={`dash-patient-tab-button ${activeTab === 'glucose' ? 'active' : ''}`}
                  onClick={() => setActiveTab('glucose')}
                >
                  🩸 Glucose Monitoring
                </button>
                <button
                  className={`dash-patient-tab-button ${activeTab === 'settings' ? 'active' : ''}`}
                  onClick={() => setActiveTab('settings')}
                >
                  ⚙️ Settings
                </button>
              </div>

              {/* Tab Content - Show category buttons when not on main */}
              {activeTab !== 'main' && (
                <div className="dash-patient-tab-content">
                  <h2 className="dash-patient-card-title">
                    {tabCategories[activeTab]?.title}
                  </h2>
                  <div className="dash-patient-quick-access-buttons">
                    {tabCategories[activeTab]?.items.map(({ name, label }) => (
                      <button
                        key={name}
                        onClick={() => handleComponentChange(name)}
                        className={`dash-patient-quick-access-button ${
                          activeComponent === name ? 'dash-patient-active' : ''
                        }`}
                        disabled={isLoading}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Active Component Display - Shows below tabs when selected */}
            {activeComponent && (
              <div className="dash-patient-active-component">
                <div className="dash-patient-dashboard-card">
                  {renderActiveComponent()}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </BloodSugarDataProvider>
  );
};

export default React.memo(PatientDashboard);
import API_BASE_URL from '../config';
/**
 * ============================================================================
 * BLOOD SUGAR DATA CONTEXT - ENHANCED VIEW-MODE FETCHING
 * ============================================================================
 *
 * VERSION: 3.7 - ACTIVITY PHARMACODYNAMICS WIRE-UP (C-1 FIX)
 *
 * NEW IN v3.7:
 * ✅ FIX C-1: calculateActiveEffects() now fetches the stacked activity PD
 *    result via fetchStackedActivityEffectSafe() and passes it as options.activityPD
 *    into calculateNetEffectAtTime(). Previously activityPD was always undefined,
 *    so cumulativeActivityEffect / activitySensitivityMultiplier / activityOnBoard
 *    were all silently zero — exercise was completely ignored by the main dashboard
 *    BG projection pipeline.
 * ✅ FIX C-1: netEffect shape now exposes cumulativeActivityEffect,
 *    activitySensitivityMultiplier and activityOnBoard so downstream consumers
 *    (ActiveEffectsDisplay, calculateAdjustedBaselineForProjection) can read them.
 * ✅ FIX L-2: Added activityLookback: 10 to every VIEW_MODE_CONFIGS entry so that
 *    the 8-hour W-state sensitivity tail is always covered when activity fetching
 *    is extended to use this config.
 *
 * VERSION: 3.6 - BASELINE STALENESS LOGIC FIX
 *
 * NEW IN v3.6:
 * ✅ FIX: calculateAdjustedBaselineForProjection no longer falls back to target_glucose
 *    when minutesSinceReading > 360. Instead it mirrors backend behaviour: a reading is
 *    valid as long as it is within the current daily period (since reset_hour). The hard
 *    6-hour clock is replaced by a readingIsInCurrentPeriod gate — eliminating the
 *    40 mg/dL stable_baseline divergence between frontend and backend.
 * ✅ FIX: When reading is stale (>6h) but still in today's period, baselineSource is set
 *    to 'stale_reading' and confidence drops to 'very_low' without changing the value.
 * ✅ FIX: confidenceMessage and warnings updated to distinguish the two cases.
 *
 * VERSION: 3.5 - USER-CONFIGURABLE DAILY RESET HOUR
 *
 * NEW IN v3.5:
 * ✅ FEATURE: Support for user-configurable daily reset hour via patientConstants.daily_reset_hour
 * ✅ UPDATED: isWithinCurrentDay calls now pass resetHour parameter (lines 929, 1057)
 * ✅ BENEFIT: Supports patients with different schedules (early risers, night owls)
 * ✅ DEFAULT: Defaults to 7 AM if not specified in patientConstants
 *
 * VERSION: 3.4 - SERVICE LAYER ROUTING
 *
 * NEW IN v3.4:
 * ✅ CLEAN IMPORTS: All utility functions now imported through service layers
 * ✅ Import routing: netEffectCalculationService acts as aggregation point
 * ✅ Functions routed through service layer:
 *    - calculateSafeCorrectionDose (from insulinStackingAnalyzer)
 *    - checkMealSafety (from mealStackingAnalyzer)
 *    - getAbsorptionProfile (from mealPharmacodynamics)
 *    - getInsulinProfile (from insulinPharmacodynamics)
 * ✅ Benefits: Single import source, clear hierarchy, reduced coupling
 *
 * NEW FEATURES:
 * 1. ✅ Dynamic meal/insulin fetch based on chart view mode
 * 2. ✅ View-aware data loading (12h, 24h, week)
 * 3. ✅ Optimized data fetching with proper lookback windows
 * 4. ✅ Performance optimizations maintained
 *
 * Author: DiaTwin Team
 * Version: 3.4 (Service Layer Routing)
 * ============================================================================
 */

import React, {createContext, useContext, useState, useEffect, useCallback, useRef, useMemo} from 'react';
import axios from 'axios';
import moment from 'moment';
import TimeManager from '../utils/TimeManager';
import TimeContext from '../contexts/TimeContext';
import {useConstants} from '../contexts/ConstantsContext';
import { SHARED_CONSTANTS } from '../constants/shared_constants';

// ============================================================================
// IMPORT SERVICES (Single Source of Truth)
// ============================================================================

// Net Effect Service - PRIMARY calculation engine
import {
  calculateNetEffectAtTime,
  calculateBaselineFromReading,
  calculateCurrentEstimatedBG,
  calculateProjectedFinalBG,
  generateChartTimeline,
  generateDetailedEffectsTimeline,
  checkInsulinDosingSafety,
  // ✅ ROUTED THROUGH SERVICE LAYER
  calculateSafeCorrectionDose,
  checkMealSafety,
  getAbsorptionProfile,
  getInsulinProfile,
  NET_EFFECT_CONSTANTS
} from '../utils/netEffectCalculationService';

// Baseline/Estimation Service
import {
  calculateStableBaseline,
  calculateRobustBaseline,
  calculateEstimationConfidence,
  estimateGlucoseAtTime,
  calculateGlucoseVelocity,
  predictGlucoseFromVelocity,
  generateSmartInterpolation,
  recommendNextReading,
  detectBaselineShift,
  assessCGMDataQuality,

} from '../utils/bloodGlucoseEstimationService';



// ✅ FIX Issue #2: Import meal and insulin calculation services
// This allows us to replace duplicate processing logic with direct service calls
import { calculateActiveMealEffects } from '../utils/mealCalculationService';
import { calculateActiveInsulinEffects } from '../utils/insulinCalculationService';

// ── Activity Pharmacodynamics API ─────────────────────────────────────────────
// fetchStackedActivityEffectSafe: non-throwing wrapper — returns null on error
// so it is safe to include in a Promise.all() chain without breaking the rest
// of calculateActiveEffects when the activity endpoint is unavailable.
import { fetchStackedActivityEffectSafe } from '../services/activityPharmacodynamicsApi';
// =====================================
// DEBUG MODE CONFIGURATION
// =====================================
const DEBUG_MODE = false;

// =====================================
// 🔥 NEW: VIEW MODE CONFIGURATIONS
// =====================================

/**
 * Define data fetch windows for each view mode
 * - pastHours: How far back to fetch data
 * - futureHours: How far forward (for projections)
 * - mealLookback: Meal fetch window (accounting for MOB duration)
 * - insulinLookback: Insulin fetch window (accounting for IOB duration)
 */
const VIEW_MODE_CONFIGS = {
  '6h': {
    label: '6 Hours',
    pastHours: 4,
    futureHours: 2,
    mealLookback: 8,       // 8h back (covers 6h MOB + buffer)
    insulinLookback: 8,    // 8h back
    activityLookback: 10   // 10h back — covers 8h W-state sensitivity tail + buffer
  },
  '12h': {
    label: '12 Hours',
    pastHours: 8,
    futureHours: 4,
    mealLookback: 12,      // 12h back (covers 6h MOB + buffer)
    insulinLookback: 12,   // 12h back (covers 8h IOB + buffer)
    activityLookback: 10   // 10h back
  },
  '24h': {
    label: '24 Hours',
    pastHours: 20,
    futureHours: 4,
    mealLookback: 24,      // 24h back
    insulinLookback: 24,   // 24h back
    activityLookback: 24   // 24h back
  },
  '3d': {
    label: '3 Days',
    pastHours: 68,
    futureHours: 4,
    mealLookback: 72,      // 72h back
    insulinLookback: 72,   // 72h back
    activityLookback: 72   // 72h back
  },
  'week': {
    label: 'Week',
    pastHours: 168,        // 7 days
    futureHours: 0,
    mealLookback: 168,     // 7 days
    insulinLookback: 168,  // 7 days
    activityLookback: 168  // 7 days
  },
  'month': {
    label: 'Month',
    pastHours: 720,        // 30 days
    futureHours: 0,
    mealLookback: 720,     // 30 days
    insulinLookback: 720,  // 30 days
    activityLookback: 720  // 30 days
  }
};



// =====================================
// 🔥 CRITICAL FIX: Deep Equality Helper
// =====================================

/**
 * Deep comparison helper for objects
 * Returns true if objects are deeply equal (prevents unnecessary re-renders)
 */
function deepEqual(obj1, obj2) {
  if (obj1 === obj2) return true;

  if (obj1 == null || obj2 == null) return false;
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return obj1 === obj2;

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  for (let key of keys1) {
    if (!keys2.includes(key)) return false;
    if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      if (!deepEqual(obj1[key], obj2[key])) return false;
    } else if (obj1[key] !== obj2[key]) {
      return false;
    }
  }

  return true;
}

// =====================================
// CONSTANTS
// =====================================

// Use T1D_BG_CONSTANTS from shared constants
const T1D_BG_CONSTANTS = {
  RECENT_READING_THRESHOLD_MIN: SHARED_CONSTANTS.T1D_BG_CONSTANTS.recent_reading_threshold_min,
  MAX_READING_AGE_MINUTES: SHARED_CONSTANTS.T1D_BG_CONSTANTS.max_reading_age_minutes,
  TARGET_GLUCOSE_DEFAULT: SHARED_CONSTANTS.T1D_BG_CONSTANTS.target_glucose_default
};

const BG_CONSTANTS = T1D_BG_CONSTANTS;

// Create the context
const BloodSugarDataContext = createContext();

// Custom hook
export const useBloodSugarData = () => {
  const context = useContext(BloodSugarDataContext);
  if (!context) {
    throw new Error('useBloodSugarData must be used within a BloodSugarDataProvider');
  }
  return context;
};

// ============================================================================
// PROVIDER COMPONENT
// ============================================================================

export const BloodSugarDataProvider = ({children}) => {
  const timeContext = useContext(TimeContext);
  const {patientConstants} = useConstants();

  // =====================================
  // STATE: Core Blood Sugar Data
  // =====================================

  const [bloodSugarData, setBloodSugarData] = useState([]);
  const [estimatedBloodSugarData, setEstimatedBloodSugarData] = useState([]);
  const [combinedData, setCombinedData] = useState([]);
  const [filteredData, setFilteredData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [targetGlucose, setTargetGlucose] = useState(120);

  // =====================================
  // STATE: 24h Data & Baseline
  // =====================================

  const [last24hData, setLast24hData] = useState([]);
  const [last24hCombinedData, setLast24hCombinedData] = useState([]);
  const [baselineHistory, setBaselineHistory] = useState([]);
  const [currentEstimatedBG, setCurrentEstimatedBG] = useState(null);

  // ✅ FIX (Bug #4): Keep ref in sync with state so generateLast24hEstimatedData
  // can read the current value without triggering re-renders.
  useEffect(() => {
    currentEstimatedBGRef.current = currentEstimatedBG;
  }, [currentEstimatedBG]);

  // =====================================
  // STATE: Meal & Insulin Data
  // =====================================

  const [recentMealsData, setRecentMealsData] = useState([]);
  const [recentInsulinData, setRecentInsulinData] = useState([]);

  // =====================================
  // 🔥 NEW: View Mode State
  // =====================================

  const [currentViewMode, setCurrentViewMode] = useState('12h');
  const [lastFetchViewMode, setLastFetchViewMode] = useState(null);


  // ✅ Helper function to calculate total carb equivalent dynamically
const calculateTotalCarbEquiv = (nutrition, patientConstants) => {
  // Try to get pre-calculated value first (for backward compatibility)
  const preCalculated = nutrition?.totalCarbEquiv || nutrition?.total_carb_equiv;
  if (preCalculated && preCalculated > 0) {
    return preCalculated;
  }

  // Calculate dynamically using current patient constants
  const carbs = nutrition?.carbs || nutrition?.totalCarbs || 0;
  const protein = nutrition?.protein || nutrition?.totalProtein || 0;
  const fat = nutrition?.fat || nutrition?.totalFat || 0;

  const proteinFactor = patientConstants?.protein_factor || 0.5;
  const fatFactor = patientConstants?.fat_factor || 0.2;

  return carbs + (protein * proteinFactor) + (fat * fatFactor);
};


  // =====================================
  // 🔥 FIX: Active Effects State (Memoized)
  // =====================================

  const [activeEffectsState, setActiveEffectsState] = useState({
    iob: null,
    mob: null,
    netEffect: null,
    insulinStacking: null,
    mealStacking: null,
    hypoRisk: null,
    hyperRisk: null,
    lastUpdate: null,
    loading: false,
    error: null
  });

  // Memoize to prevent new object reference on every render
  const activeEffects = useMemo(() => {
    return activeEffectsState;
  }, [
    activeEffectsState.iob?.total_active_insulin,
    activeEffectsState.iob?.calculation_time,
    activeEffectsState.mob?.total_active_carbs,
    activeEffectsState.mob?.calculation_time,
    activeEffectsState.netEffect?.value,
    activeEffectsState.netEffect?.timestamp,
    activeEffectsState.insulinStacking?.severity?.level,
    activeEffectsState.mealStacking?.severity?.level,
    activeEffectsState.hypoRisk?.level,
    activeEffectsState.hyperRisk?.level,
    activeEffectsState.lastUpdate,
    activeEffectsState.loading,
    activeEffectsState.error
  ]);

  // =====================================
  // 🔥 FIX: Adjusted Baseline State (Memoized)
  // =====================================

  const [adjustedBaselineState, setAdjustedBaselineState] = useState(null);

  // Memoize to prevent new object reference on every render
  const adjustedBaselineForProjection = useMemo(() => {
    return adjustedBaselineState;
  }, [
    adjustedBaselineState?.baselineValue,
    adjustedBaselineState?.currentEstimatedBG,
    adjustedBaselineState?.netEffectAtReading,
    adjustedBaselineState?.currentNetEffect,
    adjustedBaselineState?.projectedFinalBG,
    adjustedBaselineState?.confidenceScore,
    adjustedBaselineState?.minutesSinceReading,
    adjustedBaselineState?.timestamp,
    adjustedBaselineState?.activeMOB,
    adjustedBaselineState?.activeIOB
  ]);

  // =====================================
  // STATE: Enhanced Estimation Data
  // =====================================

  const [velocityData, setVelocityData] = useState(null);
  const [nextReadingRecommendation, setNextReadingRecommendation] = useState(null);
  const [baselineShiftData, setBaselineShiftData] = useState(null);
  const [dataQualityMetrics, setDataQualityMetrics] = useState(null);
  const [dataSource, setDataSource] = useState('smbg'); // 'smbg' or 'cgm'

  // =====================================
  // STATE: Configuration
  // =====================================

  const [localDateRange, setLocalDateRange] = useState({
    start: moment().subtract(8, 'hours').format('YYYY-MM-DD'),
    end: moment().add(4, 'hours').format('YYYY-MM-DD')
  });

  const [localTimeScale, setLocalTimeScale] = useState({
    start: moment().subtract(7, 'days').valueOf(),
    end: moment().valueOf(),
    tickInterval: 12,
    tickFormat: 'MM/DD HH:mm'
  });

  const [unit, setUnit] = useState('mg/dL');

  const [estimationSettings, setEstimationSettings] = useState({
    enabled: true,
    stabilizationHours: 2,
    maxConnectGapMinutes: 20,
    fillFromStart: true,
    extendToCurrent: true,
    fillEntireGraph: true,
    returnToTarget: true
  });

  // =====================================
  // REFS
  // =====================================

  const currentTimeRef = useRef(Date.now());
  const didInitialFetch = useRef(false);
  const processingData = useRef(false);
  const processing24hData = useRef(false);
  const mealInsulinSnapshotRef = useRef({ meals: [], insulin: [], timestamp: 0 });
  const baselineCalculatedRef = useRef(false);

  // ── Activity PD fetch debounce (fix 11.5) ───────────────────────────────────
  // The stacked PD endpoint runs a full ODE simulation.  The backend caches for
  // 60 s, but without a client-side guard every rapid re-render or retroactive
  // data event can still hammer the endpoint between cache misses.
  // We enforce a 30 s minimum interval here and serve the cached result for any
  // call that arrives before the interval expires.
  const ACTIVITY_FETCH_MIN_INTERVAL_MS = 30_000;
  const lastActivityFetchTimeRef = useRef(0);
  const lastActivityPDRef        = useRef(null);
  // ✅ FIX (Bug #4): Ref mirror of currentEstimatedBG so generateLast24hEstimatedData
  // can read the latest value without it being a useCallback dependency (which caused
  // an infinite re-render loop because the callback also writes currentEstimatedBG).
  const currentEstimatedBGRef = useRef(null);

  // =====================================
  // 🔥 PERFORMANCE FIX: Stable Function References (Bottleneck #2)
  // =====================================
  // Create stable references to prevent calculateActiveEffects from being recreated on every render
  const processMealsForMOBRef = useRef(null);
  const processInsulinForIOBRef = useRef(null);

  // =====================================
  // COMPUTED VALUES
  // =====================================

  const dateRange = timeContext ? timeContext.dateRange : localDateRange;
  const timeScale = timeContext ? timeContext.timeScale : localTimeScale;
  const systemDateTime = TimeManager.getSystemDateTime();
  const currentUserLogin = TimeManager.getCurrentUserLogin();

  // =====================================
  // HELPER: Blood Sugar Status
  // =====================================

  const getBloodSugarStatus = useCallback((bloodSugar, target) => {
    const statusMap = {
      'low': {color: '#ff4444', label: 'Low'},
      'normal': {color: '#00C851', label: 'Normal'},
      'high': {color: '#ff8800', label: 'High'}
    };

    if (bloodSugar < target * 0.7) return statusMap.low;
    if (bloodSugar > target * 1.3) return statusMap.high;
    return statusMap.normal;
  }, []);

  // Update current time ref every second
  useEffect(() => {
    const timer = setInterval(() => {
      currentTimeRef.current = Date.now();
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // ============================================================================
  // HELPER: Detect Retroactive Data
  // ============================================================================

  const hasRetroactiveData = useCallback((newMeals, newInsulin, lastReadingTime) => {
    if (!lastReadingTime) return false;

    const retroactiveMeals = newMeals.some(meal => {
      const mealTime = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();
      return mealTime < lastReadingTime;
    });

    const retroactiveInsulin = newInsulin.some(dose => {
      const doseTime = typeof dose.administrationTime === 'number'
        ? dose.administrationTime
        : new Date(dose.administrationTime || dose.taken_at).getTime();
      return doseTime < lastReadingTime;
    });

    if (DEBUG_MODE && (retroactiveMeals || retroactiveInsulin)) {
      console.log('🔄 Retroactive data detected:', {
        retroactiveMeals,
        retroactiveInsulin,
        lastReadingTime: new Date(lastReadingTime).toLocaleTimeString()
      });
    }

    return retroactiveMeals || retroactiveInsulin;
  }, []);

  // ============================================================================
  // DATA FETCHING: Last 24h Data (for baseline calculation)
  // ============================================================================

  const fetchLast24hData = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      const now = moment();
      const twentyFourHoursAgo = now.clone().subtract(24, 'hours');

      const startDate = twentyFourHoursAgo.format('YYYY-MM-DD');
      const endDate = now.add(1, 'hour').format('YYYY-MM-DD');

      const url = `${API_BASE_URL}/api/blood-sugar?start_date=${startDate}&end_date=${endDate}&unit=${unit}&filter_by=reading_time`;

      const response = await axios.get(url, {
        headers: {Authorization: `Bearer ${token}`}
      });

  const formattedData = response.data.map(item => {
  const readingTime = item.bloodSugarTimestamp || item.timestamp;
  // ✅ FIX: Use TimeManager instead of moment.local()
  const normalizedReadingTime = TimeManager.parseTimestamp(
    readingTime,
    TimeManager.precision.MINUTE
  );
  const itemTarget = item.target || targetGlucose;


        return {
          ...item,
         readingTime: normalizedReadingTime,
    timestamp: normalizedReadingTime,
          value: item.bloodSugar,
          status: getBloodSugarStatus(item.bloodSugar, itemTarget),
          isActualReading: true,
          isInterpolated: false,
          dataType: 'actual',
          target: itemTarget
        };
      });

      formattedData.sort((a, b) => a.readingTime - b.readingTime);
      setLast24hData(formattedData);

      if (dataSource === 'cgm' && formattedData.length > 0) {
        const qualityMetrics = assessCGMDataQuality(formattedData, 5);
        setDataQualityMetrics(qualityMetrics);

        if (DEBUG_MODE) {
          console.log('📊 CGM Data Quality:', qualityMetrics);
        }
      }

      if (DEBUG_MODE) {
        console.log(`📊 Fetched ${formattedData.length} readings for last 24h`);
      }

    } catch (err) {
      console.error('Error fetching last 24h data:', err);
    }
  }, [unit, targetGlucose, getBloodSugarStatus, dataSource]);

// ============================================================================
  // 🔥 NEW: VIEW-MODE AWARE DATA FETCHING
  // ============================================================================

// ✅ Simple cache for meal data
const mealCacheRef = useRef({
  '6h':   { data: [], timestamp: 0 },
  '12h':  { data: [], timestamp: 0 },
  '24h':  { data: [], timestamp: 0 },
  '3d':   { data: [], timestamp: 0 },
  'week': { data: [], timestamp: 0 },
  'month':{ data: [], timestamp: 0 }
});

const CACHE_DURATION = 60000; // 1 minute
const cacheLockRef = useRef({
  meals: false,
  insulin: false
});

  /**
   * Fetch meals based on current view mode
   * @param {string} viewMode - '12h', '24h', or 'week'
   * @returns {Promise<Array>} Array of meal objects
   */
const fetchRecentMeals = useCallback(async (viewMode = currentViewMode, bypassCache = false) => {
  try {
    const token = localStorage.getItem('token');
    if (!token) return [];

    // ✅ Check cache first (skip when bypassCache is true)
    const cached = mealCacheRef.current[viewMode];
    const now = Date.now();

    if (!bypassCache && cached && cached.data.length > 0 && (now - cached.timestamp) < CACHE_DURATION) {
      if (DEBUG_MODE) {
        console.log('✅ Using cached meals:', { viewMode, count: cached.data.length });
      }
      return cached.data;
    }

    const config = VIEW_MODE_CONFIGS[viewMode] || VIEW_MODE_CONFIGS['12h'];
    const lookbackHours = config.mealLookback;
    const startTime = new Date(now - lookbackHours * 60 * 60 * 1000);

    const startDate = moment(startTime).format('YYYY-MM-DD');
    const endDate = moment(now).format('YYYY-MM-DD');

    // ✅ Set limit based on view mode
    const limit = viewMode === 'month' ? 1000 : (viewMode === 'week' ? 300 : (viewMode === '3d' ? 150 : (viewMode === '24h' ? 100 : 50)));

    const url = `${API_BASE_URL}/api/meals-only?start_date=${startDate}&end_date=${endDate}&limit=${limit}`;

    if (DEBUG_MODE) {
      console.log('🍽️ Fetching meals:', { viewMode, lookbackHours, limit, startDate, endDate });
    }

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (DEBUG_MODE) {
      console.log('📥 fetchRecentMeals response:', {
        status: response.status,
        hasData: !!response.data,
        mealsCount: response.data?.meals?.length || 0
      });
    }

    if (response.data && Array.isArray(response.data.meals)) {
      const meals = response.data.meals;

      // ✅ Update cache
      mealCacheRef.current[viewMode] = {
        data: meals,
        timestamp: now
      };

      if (DEBUG_MODE) {
        console.log('✅ Fetched & cached meals:', {
          viewMode,
          count: meals.length,
          timeRange: {
            oldest: meals.length > 0 ? new Date(meals[0].timestamp).toLocaleString() : 'N/A',
            newest: meals.length > 0 ? new Date(meals[meals.length - 1].timestamp).toLocaleString() : 'N/A'
          }
        });
      }

      return meals;
    }

    return [];
  } catch (error) {
    console.error('Error fetching recent meals:', error);
    return [];
  }
}, [currentViewMode]);


  /**
   * Fetch insulin based on current view mode
   * @param {string} viewMode - '12h', '24h', or 'week'
   * @returns {Promise<Array>} Array of insulin dose objects
   */
  const fetchRecentInsulin = useCallback(async (viewMode = currentViewMode) => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return [];

      const config = VIEW_MODE_CONFIGS[viewMode] || VIEW_MODE_CONFIGS['12h'];
      const now = new Date();

      // Calculate lookback window with buffer for IOB calculation
      const lookbackHours = config.insulinLookback;
      const startTime = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

      const startDate = moment(startTime).format('YYYY-MM-DD');
      const endDate = moment(now).add(1, 'day').format('YYYY-MM-DD');

      const url = `${API_BASE_URL}/api/insulin-data?start_date=${startDate}&end_date=${endDate}`;

      if (DEBUG_MODE) {
        console.log('💉 Fetching insulin for view mode:', {
          viewMode,
          lookbackHours,
          startDate,
          endDate,
          url
        });
      }

      const response = await axios.get(url, {
        headers: {Authorization: `Bearer ${token}`}
      });

      if (response.data && response.data.insulin_logs) {
        const doses = response.data.insulin_logs;

        if (DEBUG_MODE) {
          console.log('✅ Fetched insulin:', {
            viewMode,
            count: doses.length,
            timeRange: {
              oldest: doses.length > 0 ? new Date(doses[0].taken_at || doses[0].scheduled_time).toLocaleString() : 'N/A',
              newest: doses.length > 0 ? new Date(doses[doses.length - 1].taken_at || doses[doses.length - 1].scheduled_time).toLocaleString() : 'N/A'
            }
          });
        }

        return doses;
      }

      return [];
    } catch (error) {
      console.error('Error fetching recent insulin:', error);
      return [];
    }
  }, [currentViewMode]);

  // ============================================================================
  // 🔥 NEW: VIEW MODE CHANGE HANDLER
  // ============================================================================

  /**
   * Handle view mode changes and trigger appropriate data fetches
   * @param {string} newViewMode - '12h', '24h', or 'week'
   */
  const handleViewModeChange = useCallback(async (newViewMode) => {
    if (newViewMode === currentViewMode && newViewMode === lastFetchViewMode) {
      if (DEBUG_MODE) {
        console.log('⏭️ View mode unchanged, skipping fetch');
      }
      return;
    }

    if (DEBUG_MODE) {
      console.log('🔄 View mode changed:', {
        from: currentViewMode,
        to: newViewMode,
        lastFetch: lastFetchViewMode
      });
    }

    setCurrentViewMode(newViewMode);

    // Fetch new data for the view mode
    try {
      const [freshMeals, freshInsulin] = await Promise.all([
        fetchRecentMeals(newViewMode),
        fetchRecentInsulin(newViewMode)
      ]);

      setRecentMealsData(freshMeals);
      setRecentInsulinData(freshInsulin);
      setLastFetchViewMode(newViewMode);

      if (DEBUG_MODE) {
        console.log('✅ Data fetched for new view mode:', {
          viewMode: newViewMode,
          meals: freshMeals.length,
          insulin: freshInsulin.length
        });
      }

      // Trigger active effects recalculation with new data
      if (patientConstants) {
        calculateActiveEffects();
      }
    } catch (error) {
      console.error('Error fetching data for view mode change:', error);
    }
  }, [currentViewMode, lastFetchViewMode, fetchRecentMeals, fetchRecentInsulin, patientConstants]);

  // ============================================================================
  // DATA PROCESSING: Format Meals for MOB
  // ============================================================================
  // ============================================================================
  // ✅ SIMPLIFIED: Use Meal Calculation Service (removed ALL duplicate logic)
  // ============================================================================
  const processMealsForMOB = useCallback(async (meals, currentTime) => {
    try {
      // Just filter out excluded types and let service handle everything
      const excludedTypes = ['blood_sugar_only', 'insulin_only', 'activity_only'];
      const validMeals = meals.filter(meal =>
        meal.timestamp && meal.nutrition && !excludedTypes.includes(meal.mealType)
      );

      if (validMeals.length === 0) return [];

      // ✅ Service does ALL the work - no duplicate logic
      const normalizedTime = new Date(Math.floor((currentTime || Date.now()) / 60000) * 60000);
      await calculateActiveMealEffects(validMeals, normalizedTime, patientConstants);

      // Return meals as-is - service already processed them
      return validMeals;

    } catch (error) {
      console.error('Error calling meal service:', error);
      return meals.filter(m => m.timestamp && m.nutrition &&
        !['blood_sugar_only', 'insulin_only', 'activity_only'].includes(m.mealType));
    }
  }, [patientConstants]);

  // ============================================================================
  // DATA PROCESSING: Format Insulin for IOB
  // ============================================================================

    // ============================================================================
  // ✅ SIMPLIFIED: Use Insulin Calculation Service (removed ALL duplicate logic)
  // ============================================================================
  const processInsulinForIOB = useCallback(async (insulinLogs, currentTime) => {
    try {
      // Just filter valid doses and let service handle everything
      const validDoses = insulinLogs.filter(dose =>
        (dose.taken_at || dose.scheduled_time) && dose.dose > 0
      );

      if (validDoses.length === 0) return [];

      // ✅ Service does ALL the work - no duplicate logic
      const normalizedTime = new Date(Math.floor(currentTime / 60000) * 60000);
      await calculateActiveInsulinEffects(validDoses, normalizedTime, patientConstants);

      // Return doses as-is - service already processed them
      return validDoses;

    } catch (error) {
      console.error('Error calling insulin service:', error);
      return insulinLogs.filter(d => (d.taken_at || d.scheduled_time) && d.dose > 0);
    }
  }, [patientConstants]);

  // =====================================
  // 🔥 PERFORMANCE FIX: Update Function Refs (Bottleneck #2)
  // =====================================
  // Update refs when functions change to maintain stable references
  useEffect(() => {
    processMealsForMOBRef.current = processMealsForMOB;
    processInsulinForIOBRef.current = processInsulinForIOB;
  }, [processMealsForMOB, processInsulinForIOB]);

  // ============================================================================
  // BASELINE CALCULATION: Enhanced with Robust Validation
  // ============================================================================

  // ============================================================================
  // ENHANCED BASELINE CALCULATION (with cumulative effects support)
  // ============================================================================

 const calculateEnhancedBaseline = useCallback(async (
  actualReadings,
  targetGlucoseValue,
  currentTimestamp = null,
  meals = [],
  insulinDoses = [],
  patientConstantsParam = null
) => {
  const now = currentTimestamp || Date.now();
  const constants = patientConstantsParam || patientConstants;

  if (!actualReadings || actualReadings.length === 0) {
    return {
      value: targetGlucoseValue,
      baselineValue: targetGlucoseValue,
      actualReading: null,
      timestamp: now,
      readingTimestamp: null,
      source: 'target',
      isActual: false,
      confidence: 'low',
      confidenceScore: 20,
      minutesSinceReading: null,
      netEffectAtReading: 0,
      mealImpactAtReading: 0,
      insulinImpactAtReading: 0,
      absorbedCarbsAtReading: 0,
      absorbedInsulinAtReading: 0,
      activeMOBAtReading: 0,
      activeIOBAtReading: 0,
      hasActiveEffects: false,
      warnings: ['No recent readings available']
    };
  }

  const sortedReadings = [...actualReadings]
    .filter(r => r.isActualReading && r.bloodSugar && !isNaN(r.bloodSugar))
    .sort((a, b) => b.readingTime - a.readingTime);

  if (sortedReadings.length === 0) {
    return {
      value: targetGlucoseValue,
      baselineValue: targetGlucoseValue,
      actualReading: null,
      timestamp: now,
      readingTimestamp: null,
      source: 'target',
      isActual: false,
      confidence: 'low',
      confidenceScore: 20,
      minutesSinceReading: null,
      netEffectAtReading: 0,
      mealImpactAtReading: 0,
      insulinImpactAtReading: 0,
      absorbedCarbsAtReading: 0,
      absorbedInsulinAtReading: 0,
      activeMOBAtReading: 0,
      activeIOBAtReading: 0,
      hasActiveEffects: false,
      warnings: ['No valid readings found']
    };
  }

  const mostRecentReading = sortedReadings[0];


const DEBUG_ABSORBED_ISSUE = false; // Set to false to disable debug output

if (DEBUG_ABSORBED_ISSUE) {
  console.log('🔍 ═══════════════════════════════════════════════════════════════');
  console.log('🔍 BASELINE CALCULATION DIAGNOSIS - START');
  console.log('🔍 ═══════════════════════════════════════════════════════════════');
  console.log('📱 Most Recent Reading:', {
    bloodSugar: mostRecentReading.bloodSugar,
    readingTime: new Date(mostRecentReading.readingTime).toLocaleString(),
    id: mostRecentReading.id || mostRecentReading._id,
    rawReadingTime: mostRecentReading.readingTime
  });
  console.log('🕐 Current Time:', {
    now: now,
    nowFormatted: new Date(now).toLocaleString()
  });
}

  // ✅ CRITICAL FIX: Define normalizedReadingTime BEFORE using it in filters
  const normalizedReadingTime = TimeManager.normalize(
    mostRecentReading.readingTime,
    TimeManager.precision.MINUTE
  );

  const minutesSinceReading = (now - normalizedReadingTime) / 60000;

  if (DEBUG_ABSORBED_ISSUE) {
  const secondsSinceReading = (now - normalizedReadingTime) / 1000;
  const minutesSince = secondsSinceReading / 60;

  console.log('⏱️ TIME VALIDATION:', {
    normalizedReadingTime: normalizedReadingTime,
    normalizedReadingTimeFormatted: new Date(normalizedReadingTime).toLocaleString(),
    currentTime: now,
    currentTimeFormatted: new Date(now).toLocaleString(),
    timeDifference: {
      milliseconds: now - normalizedReadingTime,
      seconds: secondsSinceReading.toFixed(2),
      minutes: minutesSince.toFixed(2),
      hours: (minutesSince / 60).toFixed(4)
    },
    isJustLogged: secondsSinceReading < 5
      ? '✅ YES (< 5 seconds ago)'
      : `❌ NO (${secondsSinceReading.toFixed(1)}s ago)`,
    expectedBehavior: secondsSinceReading < 5
      ? '✅ Step 1 and Step 2 should MATCH (same absorbed amounts)'
      : '⚠️ Step 1 and Step 2 may DIFFER (time has passed for absorption)'
  });
}


  // ✅ CRITICAL FIX: Process meals using READING TIME, not current time
  // This ensures we capture meals that were active at the reading time
  const processedMeals = meals.map(meal => {
    const nutrition = meal.nutrition || {};

    // Calculate total carb equivalent
    let totalCarbEquiv = nutrition.totalCarbEquiv || nutrition.total_carb_equiv;
    if (!totalCarbEquiv || totalCarbEquiv <= 0) {
      const carbs = nutrition.carbs || nutrition.totalCarbs || 0;
      const protein = nutrition.protein || nutrition.totalProtein || 0;
      const fat = nutrition.fat || nutrition.totalFat || 0;
      const proteinFactor = constants?.protein_factor || 0.5;
      const fatFactor = constants?.fat_factor || 0.2;
      totalCarbEquiv = carbs + (protein * proteinFactor) + (fat * fatFactor);
    }

    // Handle various timestamp formats
    let mealTimestamp;
    if (typeof meal.timestamp === 'number') {
      mealTimestamp = meal.timestamp;
    } else if (meal.timestamp) {
      mealTimestamp = TimeManager.parseTimestamp(meal.timestamp, TimeManager.precision.MINUTE);
    } else {
      return null; // Skip meals without valid timestamp
    }

    return {
      id: meal.id || meal._id,
      timestamp: mealTimestamp,
      carbEquiv: totalCarbEquiv,
      absorptionType: nutrition.absorptionType || nutrition.absorption_type ||
                      meal.absorptionType || 'medium'
    };
  }).filter(m => {
    if (!m || m.carbEquiv <= 0) return false;

    // ✅ CRITICAL FIX: Use daily reset logic for cumulative tracking
    // Include ALL meals from current day (after reset hour), not just recent ones
    // This ensures meals consumed >6 hours ago still affect cumulative baseline
    // ✅ v4.0: Use configurable reset hour from patientConstants
    const resetHour = constants?.daily_reset_hour || 7;
    const tzOffsetMinutes = constants?.timezone_offset_minutes != null
      ? constants.timezone_offset_minutes
      : -(new Date(normalizedReadingTime).getTimezoneOffset());
    const isWithinDay = TimeManager.isWithinCurrentDay(m.timestamp, normalizedReadingTime, resetHour, tzOffsetMinutes);
    const isNotFuture = m.timestamp <= normalizedReadingTime;

    if (DEBUG_MODE && isWithinDay && isNotFuture) {
      const hoursSinceMealAtReading = (normalizedReadingTime - m.timestamp) / (3600 * 1000);
      console.log('✅ Meal included for baseline calculation (daily reset):', {
        mealId: m.id,
        mealTime: new Date(m.timestamp).toLocaleTimeString(),
        readingTime: new Date(normalizedReadingTime).toLocaleTimeString(),
        hoursSinceMealAtReading: hoursSinceMealAtReading.toFixed(2),
        carbEquiv: m.carbEquiv,
        absorptionType: m.absorptionType,
        resetHour: resetHour,
        note: 'Included via daily reset logic (not duration limit)'
      });
    }

    return isWithinDay && isNotFuture;
  });

  if (DEBUG_ABSORBED_ISSUE) {
  console.log('🍽️ MEAL FILTERING DIAGNOSTICS:');
  console.log(`  📊 Total meals in database: ${meals.length}`);
  console.log(`  ✅ Meals included for baseline (Step 1): ${processedMeals.length}`);
  console.log(`  ❌ Meals excluded: ${meals.length - processedMeals.length}`);
  console.log('');

  // Show ALL meals and why they were included/excluded
  meals.forEach((meal, idx) => {
    const nutrition = meal.nutrition || {};
    let totalCarbEquiv = nutrition.totalCarbEquiv || nutrition.total_carb_equiv;
    if (!totalCarbEquiv || totalCarbEquiv <= 0) {
      const carbs = nutrition.carbs || nutrition.totalCarbs || 0;
      const protein = nutrition.protein || nutrition.totalProtein || 0;
      const fat = nutrition.fat || nutrition.totalFat || 0;
      const proteinFactor = constants?.protein_factor || 0.5;
      const fatFactor = constants?.fat_factor || 0.2;
      totalCarbEquiv = carbs + (protein * proteinFactor) + (fat * fatFactor);
    }

    let mealTimestamp;
    if (typeof meal.timestamp === 'number') {
      mealTimestamp = meal.timestamp;
    } else if (meal.timestamp) {
      mealTimestamp = TimeManager.parseTimestamp(meal.timestamp, TimeManager.precision.MINUTE);
    }

    if (!mealTimestamp) {
      console.log(`  ❌ Meal ${idx}: EXCLUDED (no valid timestamp)`, {
        mealId: meal.id || meal._id,
        hasTimestamp: !!meal.timestamp,
        timestamp: meal.timestamp
      });
      return;
    }

    const hoursSinceMealAtReading = (normalizedReadingTime - mealTimestamp) / (3600 * 1000);
    const absorptionType = nutrition.absorptionType || nutrition.absorption_type ||
                          meal.absorptionType || 'medium';
    const absorptionProfiles = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.meal_absorption_profiles;
    const profile = absorptionProfiles[absorptionType] || absorptionProfiles['medium'];
    const maxDuration = profile.duration_hours * 1.5;

    const isActiveAtReading = hoursSinceMealAtReading >= 0 &&
                             hoursSinceMealAtReading <= maxDuration &&
                             totalCarbEquiv > 0;

    const mealTime = new Date(mealTimestamp);
    const readingTime = new Date(normalizedReadingTime);

    // Determine exclusion reasons
    let reasons = [];
    if (hoursSinceMealAtReading < 0) {
      reasons.push('⚠️ FUTURE MEAL - Meal timestamp is AFTER reading time!');
      reasons.push(`   This happens when you log a meal AFTER taking the BG reading`);
      reasons.push(`   Meal: ${mealTime.toLocaleTimeString()}, Reading: ${readingTime.toLocaleTimeString()}`);
    }
    if (hoursSinceMealAtReading > maxDuration) {
      reasons.push(`Too old: ${hoursSinceMealAtReading.toFixed(2)}h > ${maxDuration.toFixed(1)}h max`);
    }
    if (totalCarbEquiv <= 0) {
      reasons.push('Zero carbs');
    }
    if (isActiveAtReading) {
      reasons = ['✅ Active at reading time'];
    }

    console.log(`  ${isActiveAtReading ? '✅' : '❌'} Meal ${idx}:`, {
      status: isActiveAtReading ? 'INCLUDED' : 'EXCLUDED',
      mealId: meal.id || meal._id,
      carbEquiv: totalCarbEquiv.toFixed(1) + 'g',
      absorptionType: absorptionType,
      mealTime: mealTime.toLocaleString(),
      readingTime: readingTime.toLocaleString(),
      hoursSinceMealAtReading: hoursSinceMealAtReading.toFixed(2) + 'h',
      maxDuration: maxDuration.toFixed(1) + 'h',
      reasons: reasons
    });
  });
  console.log('');
}



  // ✅ CRITICAL FIX: Process insulin using READING TIME, not current time
  const processedInsulin = insulinDoses.map(dose => {
    let doseTimestamp;
    if (typeof dose.administrationTime === 'number') {
      doseTimestamp = dose.administrationTime;
    } else if (dose.administrationTime) {
      doseTimestamp = TimeManager.parseTimestamp(dose.administrationTime, TimeManager.precision.SECOND);
    } else if (dose.taken_at) {
      doseTimestamp = TimeManager.parseTimestamp(dose.taken_at, TimeManager.precision.SECOND);
    } else if (dose.scheduled_time) {
      doseTimestamp = TimeManager.parseTimestamp(dose.scheduled_time, TimeManager.precision.SECOND);
    } else {
      return null;
    }

    return {
      administrationTime: doseTimestamp,
      dose: dose.dose,
      insulinType: dose.medication || dose.insulinType || 'regular_insulin'
    };
  }).filter(d => {
    if (!d || !d.administrationTime || d.dose <= 0) return false;

    // ✅ CRITICAL FIX: Use daily reset logic for cumulative tracking
    // Include ALL insulin doses from current day (after reset hour)
    // ✅ v4.0: Use configurable reset hour from patientConstants
    const resetHour = constants?.daily_reset_hour || 7;
    const tzOffsetMinutes = constants?.timezone_offset_minutes != null
      ? constants.timezone_offset_minutes
      : -(new Date(normalizedReadingTime).getTimezoneOffset());
    const isWithinDay = TimeManager.isWithinCurrentDay(d.administrationTime, normalizedReadingTime, resetHour, tzOffsetMinutes);
    const isNotFuture = d.administrationTime <= normalizedReadingTime;

    if (DEBUG_MODE && isWithinDay && isNotFuture) {
      const hoursSinceDoseAtReading = (normalizedReadingTime - d.administrationTime) / (3600 * 1000);
      console.log('✅ Insulin included for baseline calculation (daily reset):', {
        doseTime: new Date(d.administrationTime).toLocaleTimeString(),
        readingTime: new Date(normalizedReadingTime).toLocaleTimeString(),
        hoursSinceDoseAtReading: hoursSinceDoseAtReading.toFixed(2),
        dose: d.dose,
        insulinType: d.insulinType,
        resetHour: resetHour,
        note: 'Included via daily reset logic'
      });
    }

    return isWithinDay && isNotFuture;
  });

  if (DEBUG_ABSORBED_ISSUE) {
  console.log('💉 INSULIN FILTERING DIAGNOSTICS:');
  console.log(`  📊 Total insulin doses in database: ${insulinDoses.length}`);
  console.log(`  ✅ Insulin doses included for baseline (Step 1): ${processedInsulin.length}`);
  console.log(`  ❌ Insulin doses excluded: ${insulinDoses.length - processedInsulin.length}`);
  console.log('');

  insulinDoses.forEach((dose, idx) => {
    let doseTimestamp;
    if (typeof dose.administrationTime === 'number') {
      doseTimestamp = dose.administrationTime;
    } else if (dose.administrationTime) {
      doseTimestamp = TimeManager.parseTimestamp(dose.administrationTime, TimeManager.precision.SECOND);
    } else if (dose.taken_at) {
      doseTimestamp = TimeManager.parseTimestamp(dose.taken_at, TimeManager.precision.SECOND);
    } else if (dose.scheduled_time) {
      doseTimestamp = TimeManager.parseTimestamp(dose.scheduled_time, TimeManager.precision.SECOND);
    }

    if (!doseTimestamp || !dose.dose || dose.dose <= 0) {
      console.log(`  ❌ Insulin ${idx}: EXCLUDED (invalid data)`, {
        doseId: dose.id || dose._id,
        hasTimestamp: !!doseTimestamp,
        dose: dose.dose,
        administrationTime: dose.administrationTime
      });
      return;
    }

    const hoursSinceDoseAtReading = (normalizedReadingTime - doseTimestamp) / (3600 * 1000);
    const insulinType = dose.medication || dose.insulinType || 'regular_insulin';
    const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
    const profile = medicationFactors[insulinType] || medicationFactors['regular_insulin'];
    const maxDuration = profile?.duration_hours || 8;

    const isActiveAtReading = hoursSinceDoseAtReading >= 0 &&
                             hoursSinceDoseAtReading <= maxDuration;

    const doseTime = new Date(doseTimestamp);
    const readingTime = new Date(normalizedReadingTime);

    let reasons = [];
    if (hoursSinceDoseAtReading < 0) {
      reasons.push('⚠️ FUTURE DOSE - Dose timestamp is AFTER reading time!');
      reasons.push(`   Dose: ${doseTime.toLocaleTimeString()}, Reading: ${readingTime.toLocaleTimeString()}`);
    }
    if (hoursSinceDoseAtReading > maxDuration) {
      reasons.push(`Too old: ${hoursSinceDoseAtReading.toFixed(2)}h > ${maxDuration.toFixed(1)}h max`);
    }
    if (isActiveAtReading) {
      reasons = ['✅ Active at reading time'];
    }

    console.log(`  ${isActiveAtReading ? '✅' : '❌'} Insulin ${idx}:`, {
      status: isActiveAtReading ? 'INCLUDED' : 'EXCLUDED',
      doseId: dose.id || dose._id,
      dose: dose.dose.toFixed(2) + 'u',
      insulinType: insulinType,
      doseTime: doseTime.toLocaleString(),
      readingTime: readingTime.toLocaleString(),
      hoursSinceDoseAtReading: hoursSinceDoseAtReading.toFixed(2) + 'h',
      maxDuration: maxDuration.toFixed(1) + 'h',
      reasons: reasons
    });
  });
  console.log('');
}

  if (DEBUG_MODE) {
    console.log('🎯 calculateEnhancedBaseline - Meal/Insulin processing:', {
      readingTime: new Date(normalizedReadingTime).toLocaleTimeString(),
      currentTime: new Date(now).toLocaleTimeString(),
      minutesSinceReading,
      inputMeals: meals.length,
      processedMeals: processedMeals.length,
      inputInsulin: insulinDoses.length,
      processedInsulin: processedInsulin.length,
      processedMealDetails: processedMeals.map(m => ({
        id: m.id,
        carbEquiv: m.carbEquiv,
        absorptionType: m.absorptionType,
        mealTime: new Date(m.timestamp).toLocaleTimeString()
      }))
    });
  }

  // ✅ Now call calculateStableBaseline with properly filtered data
  const singleBaseline = calculateStableBaseline(
    mostRecentReading.bloodSugar,
    normalizedReadingTime,
    processedMeals,
    processedInsulin,
    constants
  );

  if (DEBUG_ABSORBED_ISSUE) {
  console.log('📊 STEP 1 CALCULATION RESULTS (At Reading Time):');
  console.log('  ┌─────────────────────────────────────────');
  console.log('  │ READING INFORMATION');
  console.log('  ├─────────────────────────────────────────');
  console.log('  │ Reading BG:', singleBaseline.actualReading, 'mg/dL');
  console.log('  │ Reading Time:', new Date(normalizedReadingTime).toLocaleString());
  console.log('  │');
  console.log('  │ ABSORBED AMOUNTS (at reading time)');
  console.log('  ├─────────────────────────────────────────');
  console.log('  │ Absorbed Carbs:', singleBaseline.absorbedCarbsAtReading?.toFixed(1) || '0.0', 'g');
  console.log('  │ Absorbed Insulin:', singleBaseline.absorbedInsulinAtReading?.toFixed(2) || '0.00', 'u');
  console.log('  │');
  console.log('  │ ACTIVE AMOUNTS (still pending at reading)');
  console.log('  ├─────────────────────────────────────────');
  console.log('  │ Active MOB:', singleBaseline.activeMOBAtReading?.toFixed(1) || '0.0', 'g');
  console.log('  │ Active IOB:', singleBaseline.activeIOBAtReading?.toFixed(2) || '0.00', 'u');
  console.log('  │');
  console.log('  │ IMPACTS ON BLOOD GLUCOSE');
  console.log('  ├─────────────────────────────────────────');
  console.log('  │ Meal Impact:', singleBaseline.mealImpact?.toFixed(1) || '0.0', 'mg/dL');
  console.log('  │ Insulin Impact:', singleBaseline.insulinImpact?.toFixed(1) || '0.0', 'mg/dL');
  console.log('  │ Net Effect:', singleBaseline.netEffectAtReading?.toFixed(1) || '0.0', 'mg/dL');
  console.log('  │');
  console.log('  │ CALCULATED BASELINE');
  console.log('  ├─────────────────────────────────────────');
  console.log('  │ Baseline:', singleBaseline.baseline, 'mg/dL');
  console.log('  │ Is Valid:', singleBaseline.isValid);
  console.log('  └─────────────────────────────────────────');
  console.log('');

  if (singleBaseline.mealContributions && singleBaseline.mealContributions.length > 0) {
    console.log('  🍽️ MEAL CONTRIBUTIONS (detailed breakdown):');
    singleBaseline.mealContributions.forEach((meal, idx) => {
      const mealTime = normalizedReadingTime - (meal.hoursSinceMeal * 3600000);
      console.log(`    ${idx + 1}. Meal at ${new Date(mealTime).toLocaleTimeString()}:`);
      console.log(`       Total Carbs: ${meal.totalCarbs}g`);
      console.log(`       Hours Since Meal: ${meal.hoursSinceMeal.toFixed(2)}h`);
      console.log(`       Absorbed: ${meal.absorbedCarbs.toFixed(1)}g`);
      console.log(`       MOB (still pending): ${meal.mob.toFixed(1)}g`);
      console.log(`       Absorption Type: ${meal.absorptionType || 'medium'}`);
    });
  } else {
    console.log('  🍽️ No active meals at reading time');
  }
  console.log('');

  if (singleBaseline.insulinContributions && singleBaseline.insulinContributions.length > 0) {
    console.log('  💉 INSULIN CONTRIBUTIONS (detailed breakdown):');
    singleBaseline.insulinContributions.forEach((insulin, idx) => {
      const doseTime = normalizedReadingTime - (insulin.hoursSinceDose * 3600000);
      console.log(`    ${idx + 1}. Dose at ${new Date(doseTime).toLocaleTimeString()}:`);
      console.log(`       Initial Dose: ${insulin.initialDose}u`);
      console.log(`       Insulin Type: ${insulin.insulinType}`);
      console.log(`       Hours Since Dose: ${insulin.hoursSinceDose.toFixed(2)}h`);
      console.log(`       Absorbed: ${insulin.absorbedInsulin.toFixed(2)}u`);
      console.log(`       IOB (still active): ${insulin.iob.toFixed(2)}u`);
    });
  } else {
    console.log('  💉 No active insulin at reading time');
  }
  console.log('');
  console.log('🔍 ═══════════════════════════════════════════════════════════════');
  console.log('🔍 BASELINE CALCULATION DIAGNOSIS - END');
  console.log('🔍 ═══════════════════════════════════════════════════════════════');
  console.log('');
}

  let confidenceLevel = 'medium';
  let confidenceScore = 70;
  let confidenceMessage = 'Single reading baseline';
  let stabilityMetrics = null;

  if (sortedReadings.length >= 3) {
    const recentReadings = sortedReadings.slice(0, 5).map(r => ({
      value: r.bloodSugar,
      timestamp: r.readingTime
    }));

    const robustBaseline = calculateRobustBaseline(
      recentReadings,
      processedMeals,
      processedInsulin,
      constants
    );

    if (robustBaseline.baseline && robustBaseline.confidence !== 'none') {
      confidenceLevel = robustBaseline.confidence;
      stabilityMetrics = robustBaseline.stability;

      const currentEstimate = estimateGlucoseAtTime(
        singleBaseline.baseline,
        now,
        normalizedReadingTime,
        processedMeals,
        processedInsulin,
        constants,
        {
          baselineStability: robustBaseline.stability?.stdDev || 0,
          dataSource: dataSource,
          includeConfidence: true
        }
      );

      confidenceScore = currentEstimate.confidence?.value || 75;
      confidenceMessage = currentEstimate.confidence?.message || 'Multi-reading validation';
    }
  }

  if (!singleBaseline.isValid) {
    console.warn('⚠️ Single baseline calculation failed, using actual reading');
    return {
      value: mostRecentReading.bloodSugar,
      baselineValue: mostRecentReading.bloodSugar,
      actualReading: mostRecentReading.bloodSugar,
      timestamp: now,
      readingTimestamp: normalizedReadingTime,
      source: 'actual',
      isActual: true,
      confidence: minutesSinceReading <= 15 ? 'high' : 'medium',
      confidenceScore: minutesSinceReading <= 15 ? 90 : 70,
      minutesSinceReading: Math.round(minutesSinceReading * 10) / 10,
      netEffectAtReading: 0,
      mealImpactAtReading: 0,
      insulinImpactAtReading: 0,
      absorbedCarbsAtReading: 0,
      absorbedInsulinAtReading: 0,
      activeMOBAtReading: 0,
      activeIOBAtReading: 0,
      hasActiveEffects: false,
      warnings: singleBaseline.warnings || ['Could not calculate stable baseline']
    };
  }

return {
  // 🔥 CRITICAL FIX: Use CUMULATIVE BASELINE instead of instantaneous baseline
  // The cumulative baseline includes ALL absorbed effects from the entire day (since 7 AM)
  // while the instantaneous baseline only includes currently active meals/insulin
  value: singleBaseline.cumulativeBaseline,           // ✅ CHANGED from singleBaseline.baseline
  baselineValue: singleBaseline.cumulativeBaseline,   // ✅ CHANGED from singleBaseline.baseline
  actualReading: mostRecentReading.bloodSugar,
  timestamp: now,
  readingTimestamp: normalizedReadingTime,
  source: sortedReadings.length >= 3 ? 'calculated_with_validation' : 'calculated',
  isActual: false,
  confidence: confidenceLevel,
  confidenceScore: confidenceScore,
  confidenceMessage: confidenceMessage,
  minutesSinceReading: Math.round(minutesSinceReading * 10) / 10,
// INSTANTANEOUS VALUES (at reading time - for backward compatibility)
  netEffectAtReading: singleBaseline.netEffectAtReading,
  mealImpactAtReading: singleBaseline.mealImpact,
  insulinImpactAtReading: singleBaseline.insulinImpact,
  absorbedCarbsAtReading: singleBaseline.absorbedCarbsAtReading,
  absorbedInsulinAtReading: singleBaseline.absorbedInsulinAtReading,
  activeMOBAtReading: singleBaseline.activeMOBAtReading,
  activeIOBAtReading: singleBaseline.activeIOBAtReading,

  // 🆕 CUMULATIVE VALUES AT READING TIME (bank balance - includes fully absorbed)
  // These are what Step 1 should display!
  cumulativeNetEffectAtReading: singleBaseline.cumulativeNetEffect,
  cumulativeMealEffectAtReading: singleBaseline.cumulativeMealEffect,
  cumulativeInsulinEffectAtReading: singleBaseline.cumulativeInsulinEffect,
  cumulativeTotalCarbsEatenAtReading: singleBaseline.cumulativeTotalCarbsEaten,
  cumulativeTotalAbsorbedCarbsAtReading: singleBaseline.cumulativeTotalAbsorbedCarbs,
  cumulativeTotalInsulinDosedAtReading: singleBaseline.cumulativeTotalInsulinDosed,
  cumulativeTotalAbsorbedInsulinAtReading: singleBaseline.cumulativeTotalAbsorbedInsulin,

  hasActiveEffects: singleBaseline.hasActiveEffects,
  stability: stabilityMetrics,
  warnings: singleBaseline.warnings || [],
  dataPoint: mostRecentReading,

  // ✅ CRITICAL: Add these lines to pass meal/insulin contributions to UI
  mealContributions: singleBaseline.mealContributions || [],
  insulinContributions: singleBaseline.insulinContributions || []
};


}, [patientConstants, dataSource]);
  // ============================================================================
  // BASELINE PROJECTION: Delegate to Net Effect Service
  // ============================================================================

const calculateAdjustedBaselineForProjection = useCallback(() => {
    if (!currentEstimatedBG || currentEstimatedBG.source === 'loading') {
      return null;
    }

    const now = TimeManager.getCurrentTime(TimeManager.precision.SECOND);
    const correctionFactor = patientConstants?.correction_factor || 50;
    const carbToBGFactor = patientConstants?.carb_to_bg_factor || 4.0;

    const baselineValue = currentEstimatedBG.baselineValue || currentEstimatedBG.value;
    const actualReading = currentEstimatedBG.actualReading || null;
    const readingTimestamp = currentEstimatedBG.readingTimestamp || now;
    const minutesSinceReading = (now - readingTimestamp) / 60000;

    // Instantaneous values (at reading time - backward compatibility)
    const mealImpactAtReading = currentEstimatedBG.mealImpactAtReading || 0;
    const insulinImpactAtReading = currentEstimatedBG.insulinImpactAtReading || 0;
    const netEffectAtReading = currentEstimatedBG.netEffectAtReading || 0;
    const absorbedCarbsAtReading = currentEstimatedBG.absorbedCarbsAtReading || 0;
    const absorbedInsulinAtReading = currentEstimatedBG.absorbedInsulinAtReading || 0;
    const activeMOBAtReading = currentEstimatedBG.activeMOBAtReading || 0;
    const activeIOBAtReading = currentEstimatedBG.activeIOBAtReading || 0;

    // 🆕 CUMULATIVE VALUES (at reading time - bank balance approach)
    const cumulativeNetEffectAtReading = currentEstimatedBG.cumulativeNetEffectAtReading || 0;
    const cumulativeMealEffectAtReading = currentEstimatedBG.cumulativeMealEffectAtReading || 0;
    const cumulativeInsulinEffectAtReading = currentEstimatedBG.cumulativeInsulinEffectAtReading || 0;
    const cumulativeTotalCarbsEatenAtReading = currentEstimatedBG.cumulativeTotalCarbsEatenAtReading || 0;
    const cumulativeTotalAbsorbedCarbsAtReading = currentEstimatedBG.cumulativeTotalAbsorbedCarbsAtReading || 0;
    const cumulativeTotalInsulinDosedAtReading = currentEstimatedBG.cumulativeTotalInsulinDosedAtReading || 0;
    const cumulativeTotalAbsorbedInsulinAtReading = currentEstimatedBG.cumulativeTotalAbsorbedInsulinAtReading || 0;

    const targetGlucose = patientConstants?.target_glucose || 120;
    let effectiveBaseline = baselineValue;
    let baselineSource = currentEstimatedBG.source;
    let confidence = currentEstimatedBG.confidence;
    let confidenceScore = currentEstimatedBG.confidenceScore || 50;

    // ✅ Option A fix: mirror the backend's validity window.
    // A reading is valid as long as it falls within the CURRENT DAILY PERIOD
    // (i.e. after today's reset hour). Only fall back to target_glucose when
    // the reading is from a previous day's period — NOT based on a hard 6-hour clock.
    // This eliminates the 40 mg/dL divergence caused by the frontend abandoning a
    // valid same-day reading while the backend still uses it.
    const resetHour = patientConstants?.daily_reset_hour || 7;
    const resetTimeMs = TimeManager.getDailyResetTime(now, resetHour);
    const readingIsInCurrentPeriod = readingTimestamp >= resetTimeMs;

    if (!readingIsInCurrentPeriod) {
      // Reading is from before today's reset — no valid same-day anchor, use target
      effectiveBaseline = targetGlucose;
      baselineSource = 'target_fallback';
      confidence = 'very_low';
      confidenceScore = 20;

      if (DEBUG_MODE) {
        console.log('⚠️ Reading is from before daily reset, using target as baseline:', {
          targetGlucose,
          readingTimestamp: new Date(readingTimestamp).toLocaleTimeString(),
          resetTime: new Date(resetTimeMs).toLocaleTimeString()
        });
      }
    } else if (minutesSinceReading > 360) {
      // Reading is within today's period but > 6 hours old.
      // ✅ Keep the actual derived baseline — do NOT replace with target.
      // Just lower confidence so the UI can warn the user appropriately.
      baselineSource = 'stale_reading';
      confidence = 'very_low';
      confidenceScore = 20;

      if (DEBUG_MODE) {
        console.log('⚠️ Reading > 6 hours old but within current daily period — using derived baseline with lowered confidence:', {
          effectiveBaseline,
          minutesSinceReading: Math.round(minutesSinceReading)
        });
      }
    }

    // ============================================================================
    // 🆕 CUMULATIVE BASELINE FIX: Extract cumulative values from activeEffects
    // ============================================================================

    // Get cumulative baseline - the "bank balance" of absorbed effects
    let cumulativeMealEffect = 0;
    let cumulativeInsulinEffect = 0;
    let cumulativeNetBaseline = 0;

    // Get instantaneous net effect - the "rate of change" for display
    let instantaneousNetEffect = 0;

    if (activeEffects?.netEffect) {
      cumulativeMealEffect = activeEffects.netEffect.cumulativeMealEffect || 0;
      cumulativeInsulinEffect = activeEffects.netEffect.cumulativeInsulinEffect || 0;
      cumulativeNetBaseline = activeEffects.netEffect.cumulativeNetBaseline || 0;
      instantaneousNetEffect = activeEffects.netEffect.value || 0;
    }

    // ============================================================================
    // Extract MOB/IOB values for pending effects display
    // ============================================================================

    let currentAbsorbedCarbs = 0;
    let currentMOB = 0;
    let currentMealImpact = 0;
    let pendingMealRise = 0;

    if (activeEffects?.mob) {
      currentMOB = activeEffects.mob.total_active_carbs || 0;
      currentMealImpact = activeEffects.mob.current_bg_elevation ||
                          activeEffects.mob.expected_bg_impact || 0;
      currentAbsorbedCarbs = activeEffects.mob.total_absorbed_carbs || 0;
      pendingMealRise = activeEffects.mob.pending_bg_rise ||
                       (currentMOB * carbToBGFactor);
    }

    let currentAbsorbedInsulin = 0;
    let currentIOB = 0;
    let pendingInsulinReduction = 0;

    if (activeEffects.iob?.insulin_contributions) {
      activeEffects.iob.insulin_contributions.forEach(contrib => {
        const initialDose = contrib.initial_dose || contrib.dose;
        const iob = contrib.iob || 0;
        const absorbed = Math.max(0, initialDose - iob);
        currentAbsorbedInsulin += absorbed;
        currentIOB += iob;
      });
    }

    const currentInsulinImpact = currentAbsorbedInsulin * correctionFactor;
    pendingInsulinReduction = currentIOB * correctionFactor;

    // ============================================================================
    // 🔥 CRITICAL FIX: Use cumulative baseline for current BG estimation
    // ============================================================================
    // OLD (WRONG): const currentEstimatedBGValue = effectiveBaseline + currentNetEffect;
    // This used instantaneous activity which goes to 0 after absorption completes
    //
    // NEW (CORRECT): Use cumulative baseline which persists after absorption
    const currentEstimatedBGValue = effectiveBaseline + cumulativeNetBaseline;

    // Projected final BG adds pending effects to current position
    const projectedFinalBG = currentEstimatedBGValue + pendingMealRise - pendingInsulinReduction;

    return {
      baselineValue: Math.round(effectiveBaseline),
      baselineSource: baselineSource,
      actualReading: actualReading ? Math.round(actualReading) : null,
      mealImpactAtReading: Math.round(mealImpactAtReading * 10) / 10,
      insulinImpactAtReading: Math.round(insulinImpactAtReading * 10) / 10,
      netEffectAtReading: Math.round(netEffectAtReading * 10) / 10,
      absorbedCarbsAtReading: Math.round(absorbedCarbsAtReading * 10) / 10,
      absorbedInsulinAtReading: Math.round(absorbedInsulinAtReading * 100) / 100,
      activeMOBAtReading: Math.round(activeMOBAtReading * 10) / 10,
      activeIOBAtReading: Math.round(activeIOBAtReading * 100) / 100,

      // 🆕 CUMULATIVE VALUES AT READING TIME - Critical for consistent baseline tracking
      cumulativeNetEffectAtReading: Math.round(cumulativeNetEffectAtReading * 10) / 10,
      cumulativeMealEffectAtReading: Math.round(cumulativeMealEffectAtReading * 10) / 10,
      cumulativeInsulinEffectAtReading: Math.round(cumulativeInsulinEffectAtReading * 10) / 10,
      cumulativeTotalCarbsEatenAtReading: Math.round(cumulativeTotalCarbsEatenAtReading * 10) / 10,
      cumulativeTotalAbsorbedCarbsAtReading: Math.round(cumulativeTotalAbsorbedCarbsAtReading * 10) / 10,
      cumulativeTotalInsulinDosedAtReading: Math.round(cumulativeTotalInsulinDosedAtReading * 100) / 100,
      cumulativeTotalAbsorbedInsulinAtReading: Math.round(cumulativeTotalAbsorbedInsulinAtReading * 100) / 100,

      // 🆕 CUMULATIVE BASELINE VALUES - The "bank balance" (persists after absorption)
      cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
      cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
      cumulativeNetBaseline: Math.round(cumulativeNetBaseline * 10) / 10,

      // Instantaneous net effect - The "rate of change" (goes to 0 after absorption)
      currentNetEffect: Math.round(instantaneousNetEffect * 10) / 10,

      mealImpact: Math.round(currentMealImpact * 10) / 10,
      insulinImpact: Math.round(currentInsulinImpact * 10) / 10,
      currentAbsorbedCarbs: Math.round(currentAbsorbedCarbs * 10) / 10,
      currentAbsorbedInsulin: Math.round(currentAbsorbedInsulin * 100) / 100,
      pendingMealRise: Math.round(pendingMealRise * 10) / 10,
      pendingInsulinReduction: Math.round(pendingInsulinReduction * 10) / 10,
      activeMOB: Math.round(currentMOB * 10) / 10,
      activeIOB: Math.round(currentIOB * 100) / 100,
      currentEstimatedBG: Math.round(currentEstimatedBGValue),
      projectedFinalBG: Math.round(projectedFinalBG),
      source: baselineSource,
      confidence: confidence,
      confidenceScore: confidenceScore,
      confidenceMessage: !readingIsInCurrentPeriod
        ? 'Reading from previous period — using target as baseline'
        : minutesSinceReading > 360
          ? `Stale reading (${Math.round(minutesSinceReading / 60)}h old) — derived baseline used with low confidence`
          : currentEstimatedBG.confidenceMessage,
      timestamp: now,
      readingTimestamp: readingTimestamp,
      minutesSinceReading: Math.round(minutesSinceReading),
      hasActiveEffects: currentIOB > 0.01 || currentMOB > 0.1,
      requiresPhysicianReview: confidence === 'low' || Math.abs(instantaneousNetEffect) > 100,
      insulinStacking: activeEffects.insulinStacking || null,
      mealStacking: activeEffects.mealStacking || null,
      hypoRisk: activeEffects.hypoRisk || null,
      hyperRisk: activeEffects.hyperRisk || null,
      velocity: velocityData ? {
        trend: velocityData.trend,
        arrow: velocityData.arrow,
        velocityPerHour: velocityData.velocityPerHour,
        direction: velocityData.direction,
        prediction: velocityData.prediction
      } : null,
      stability: currentEstimatedBG.stability || null,
      warnings: !readingIsInCurrentPeriod
        ? ['Reading from previous daily period — target glucose used as baseline fallback']
        : minutesSinceReading > 360
          ? [`Reading is ${Math.round(minutesSinceReading / 60)}h old — baseline derived from stale reading, accuracy reduced`]
          : (currentEstimatedBG.warnings || []),

      // ✅ Pass meal/insulin contributions
      mealContributions: currentEstimatedBG.mealContributions || [],
      insulinContributions: currentEstimatedBG.insulinContributions || []
    };
  }, [currentEstimatedBG, activeEffects, patientConstants, velocityData]);
// ============================================================================
  // PART 3: ACTIVE EFFECTS CALCULATION & CONTEXT VALUE
  // ============================================================================

  // ============================================================================
  // 🔥 FIX: Active Effects Calculation (With Conditional Updates)
  // ============================================================================

  // ============================================================================
// 🔥 FIX: Active Effects Calculation (With Conditional Updates)
// ============================================================================

const calculateActiveEffects = useCallback(async () => {
  if (!patientConstants) {
    if (DEBUG_MODE) console.log('⏳ Waiting for patient constants');
    return;
  }

  const now = Date.now();

  if (processing24hData.current) {
    if (DEBUG_MODE) console.log('⏸️ Active effects calculation in progress, skipping');
    return;
  }

  try {
    processing24hData.current = true;

    // 🔥 FIX: Use setState function
    setActiveEffectsState(prev => ({...prev, loading: true}));

    if (DEBUG_MODE) console.log('🚀 Starting active effects calculation');

    const [freshMeals, freshInsulin, activityPD] = await Promise.all([
      fetchRecentMeals(),
      fetchRecentInsulin(),
      // ✅ FIX C-1: fetch stacked activity PD; returns null on any error so it
      // never breaks the rest of this function. null → undefined below so the
      // service's ?? defaults (0 / 1.0) apply cleanly when the fetch fails.
      //
      // ✅ FIX 11.5: Client-side 30 s debounce — prevents the ODE endpoint from
      // being called on every rapid re-render or retroactive-data event.
      // The backend has a 60 s TTL cache, but without this guard each poll cycle
      // can still cause a cache miss on the leading edge of that window.
      // We serve the last known activityPD for any call within 30 s of the
      // previous fetch; only the first call or calls after the interval actually
      // hit the network.
      (async () => {
        const now = Date.now();
        if (now - lastActivityFetchTimeRef.current < ACTIVITY_FETCH_MIN_INTERVAL_MS) {
          if (DEBUG_MODE) {
            console.log(
              '[activityPD] debounce — reusing cached result, next fetch in',
              Math.ceil((ACTIVITY_FETCH_MIN_INTERVAL_MS - (now - lastActivityFetchTimeRef.current)) / 1000),
              's'
            );
          }
          return lastActivityPDRef.current;
        }
        const result = await fetchStackedActivityEffectSafe();
        lastActivityFetchTimeRef.current = now;
        lastActivityPDRef.current        = result;
        return result;
      })()
    ]);

    if (DEBUG_MODE) {
      console.log(`📊 Fetched: ${freshMeals.length} meals, ${freshInsulin.length} insulin doses, activityPD:`, activityPD ? `cumEffect=${activityPD.cumulative_activity_effect}, sensitivity=×${activityPD.sensitivity_multiplier}` : 'null (no activity data)');
    }

    setRecentMealsData(freshMeals);
    setRecentInsulinData(freshInsulin);

    const lastReading = last24hData.length > 0
      ? last24hData[last24hData.length - 1]
      : null;

    const needsBaselineRecalc = lastReading && hasRetroactiveData(
      freshMeals,
      freshInsulin,
      lastReading.readingTime
    );

    if (DEBUG_MODE && needsBaselineRecalc) {
      console.log('🔄 RETROACTIVE DATA DETECTED - Baseline recalculation required');
    }

    mealInsulinSnapshotRef.current = {
      meals: freshMeals,
      insulin: freshInsulin,
      timestamp: now
    };

    // ============================================================================
    // 🔥 CRITICAL FIX: Process meals/insulin for cumulative calculations
    // ============================================================================
    // The issue was that we were only passing meals within the 8-hour MOB window
    // to calculateNetEffectAtTime, which prevented it from calculating cumulative
    // effects from earlier meals in the day. Now we pass ALL meals from the
    // current day, and let the service filter appropriately for:
    // - MOB calculation (8-hour window)
    // - Cumulative calculation (all meals since 7 AM reset)

    // Process ALL meals for cumulative tracking (service will filter by MOB window internally)
    const allProcessedMeals = freshMeals.map(meal => {
      const nutrition = meal.nutrition || {};
      let totalCarbEquiv = nutrition.totalCarbEquiv || nutrition.total_carb_equiv;

      if (!totalCarbEquiv || totalCarbEquiv <= 0) {
        const carbs = nutrition.carbs || nutrition.totalCarbs || 0;
        const protein = nutrition.protein || nutrition.totalProtein || 0;
        const fat = nutrition.fat || nutrition.totalFat || 0;
        const proteinFactor = patientConstants?.protein_factor || 0.5;
        const fatFactor = patientConstants?.fat_factor || 0.2;
        totalCarbEquiv = carbs + (protein * proteinFactor) + (fat * fatFactor);
      }

      return {
        id: meal.id || meal._id,
        timestamp: meal.timestamp,
        carbEquiv: totalCarbEquiv,
        absorptionType: nutrition.absorptionType || nutrition.absorption_type || meal.absorptionType || 'medium',
        nutrition: meal.nutrition,
        mealType: meal.mealType,
        foodItems: meal.foodItems || []
      };
    }).filter(m => m.carbEquiv > 0);

    // Process ALL insulin for cumulative tracking (service will filter by IOB window internally)
    const allProcessedInsulin = freshInsulin.map(dose => ({
      administrationTime: dose.administrationTime || dose.taken_at,
      dose: dose.dose,
      medication: dose.medication || dose.insulinType || 'regular_insulin',
      insulinType: dose.medication || dose.insulinType || 'regular_insulin'
    })).filter(d => d.dose > 0);

    if (DEBUG_MODE) {
      console.log(`📊 Processed ALL meals/insulin for cumulative: ${allProcessedMeals.length} meals, ${allProcessedInsulin.length} insulin doses`);
      console.log('🔍 Meal timestamps:', allProcessedMeals.map(m => ({
        time: new Date(m.timestamp).toLocaleTimeString(),
        carbs: m.carbEquiv
      })));
    }

    const currentBG = last24hData.length > 0
      ? last24hData[last24hData.length - 1].bloodSugar
      : null;

    const t1dDuration = patientConstants.t1d_duration_years || 5;

    // ✅ FIX C-1: Pass ALL meals/insulin AND activityPD — service will handle
    // MOB, cumulative, and activity calculations in a single pass.
    // activityPD is null when the fetch failed; null → undefined converts it so
    // the service's `?? 0` / `?? 1.0` fallbacks inside calculateNetEffectAtTime
    // apply correctly and the function degrades gracefully (effect = 0).
    const netEffectResult = await calculateNetEffectAtTime(
      allProcessedMeals,      // ✅ All meals - service filters for MOB & cumulative separately
      allProcessedInsulin,    // ✅ All insulin - service filters for IOB & cumulative separately
      now,
      patientConstants,
      {
        currentBG:   currentBG,
        t1dDuration: t1dDuration,
        activityPD:  activityPD ?? undefined  // ✅ C-1: inject activity PD result
      }
    );

    const newActiveEffects = {
      mob: {
        total_active_carbs: netEffectResult.totalActiveCarbs,
        total_absorbed_carbs: netEffectResult.totalAbsorbedCarbs,
        current_bg_elevation: netEffectResult.mealImpact,
        expected_bg_impact: netEffectResult.mealImpact,
        pending_bg_rise: netEffectResult.pendingMealRise,
        meal_contributions: netEffectResult.mobDetails?.mob?.meal_contributions || [],
        active_meals_count: netEffectResult.mobDetails?.mob?.active_meals_count || 0,
        calculation_time: now
      },
      iob: {
        total_active_insulin: netEffectResult.totalActiveInsulin,
        insulin_contributions: netEffectResult.iobDetails?.insulinContributions || [],
        bg_impact: netEffectResult.insulinImpact,
        calculation_time: now
      },
      netEffect: {
        value: netEffectResult.netEffect,
        mealImpact: netEffectResult.mealImpact,
        insulinImpact: netEffectResult.insulinImpact,
        // 🆕 CUMULATIVE BASELINE FIX: Add cumulative values for accurate BG estimation
        cumulativeMealEffect: netEffectResult.cumulativeMealEffect || 0,
        cumulativeInsulinEffect: netEffectResult.cumulativeInsulinEffect || 0,
        cumulativeNetBaseline: netEffectResult.cumulativeNetBaseline || 0,
        // ✅ FIX C-1: Activity terms — previously always 0 because activityPD was
        // never passed into calculateNetEffectAtTime. Now populated correctly.
        cumulativeActivityEffect: netEffectResult.cumulativeActivityEffect || 0,
        activitySensitivityMultiplier: netEffectResult.activitySensitivityMultiplier || 1.0,
        activityOnBoard: netEffectResult.activityOnBoard || 0,
        activityContributions: netEffectResult.activityContributions || [],
        timestamp: now
      },
      insulinStacking: netEffectResult.insulinStacking,
      mealStacking: netEffectResult.mealStacking,
      hypoRisk: netEffectResult.hypoRisk,
      hyperRisk: netEffectResult.hyperRisk,
      lastUpdate: now,
      loading: false,
      error: null
    };

    // 🔥 FIX: Only update if values actually changed
    setActiveEffectsState(prev => {
      if (deepEqual(prev, newActiveEffects)) {
        if (DEBUG_MODE) console.log('⏭️ Active effects unchanged, skipping update');
        return prev;
      }
      if (DEBUG_MODE) console.log('✅ Active effects updated');
      return newActiveEffects;
    });

    // ✅ CRITICAL FIX: Recalculate baseline with RAW (unprocessed) meals/insulin
    // This allows calculateEnhancedBaseline to filter by READING TIME
    if (last24hData.length > 0) {
      const sortedReadings = [...last24hData]
        .filter(r => r.isActualReading && r.bloodSugar && !isNaN(r.bloodSugar))
        .sort((a, b) => b.readingTime - a.readingTime);

      if (sortedReadings.length > 0) {
        if (DEBUG_MODE) {
          console.log('🎯 Recalculating baseline with RAW meal/insulin data (will filter by reading time)');
        }

        // ✅ CRITICAL FIX: Pass RAW freshMeals and freshInsulin, NOT processedMeals/processedInsulin
        // calculateEnhancedBaseline will filter them based on READING TIME
        const newBaseline = await calculateEnhancedBaseline(
          sortedReadings,
          targetGlucose,
          now,
          freshMeals,      // ✅ RAW meals - will be filtered by reading time inside
          freshInsulin,    // ✅ RAW insulin - will be filtered by reading time inside
          patientConstants
        );

        setCurrentEstimatedBG(newBaseline);
        baselineCalculatedRef.current = true;

        if (DEBUG_MODE) {
          console.log('✅ Baseline recalculated:', {
            baselineValue: newBaseline.baselineValue,
            confidence: newBaseline.confidence,
            absorbedCarbsAtReading: newBaseline.absorbedCarbsAtReading,
            mealImpactAtReading: newBaseline.mealImpactAtReading
          });
        }
      }
    }

  } catch (error) {
    console.error('❌ Error calculating active effects:', error);
    setActiveEffectsState(prev => ({
      ...prev,
      loading: false,
      error: error.message
    }));
  } finally {
    processing24hData.current = false;
  }
}, [
  patientConstants,
  targetGlucose,
  last24hData.length,  // 🔥 OPTIMIZATION: Use .length since readings are immutable once created
  // Only need to recalculate when new readings are added, not when array reference changes
  fetchRecentMeals,
  fetchRecentInsulin,
  fetchStackedActivityEffectSafe,  // ✅ C-1: stable module-level reference, no render loop risk
  // REMOVED: processMealsForMOB, processInsulinForIOB (now using refs)
  calculateEnhancedBaseline,
  hasRetroactiveData
]);

  // ============================================================================
  // EFFECTS: Trigger Active Effects Calculation
  // ============================================================================

  useEffect(() => {
    if (!patientConstants || last24hData.length === 0) return;

    // ── 1. Run immediately ──────────────────────────────────────────────────
    calculateActiveEffects();

    // ── 2. Sync to next :00 boundary, then tick every 60 s ─────────────────
    // BUG FIX: The previous pattern did `return () => clearInterval(interval)`
    // inside the setTimeout callback — that return value goes nowhere, so the
    // interval was leaked and never cleaned up. We capture intervalId in the
    // outer scope so the useEffect cleanup can reach it.
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let intervalId = null;

    const syncTimeout = setTimeout(() => {
      calculateActiveEffects();
      intervalId = setInterval(calculateActiveEffects, 60000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(syncTimeout);
      if (intervalId) clearInterval(intervalId);
    };
  }, [patientConstants, last24hData.length, calculateActiveEffects]);

  // ============================================================================
  // 🔥 FIX: Update Adjusted Baseline (With Conditional Updates)
  // ============================================================================

  useEffect(() => {
    if (currentEstimatedBG && currentEstimatedBG.source !== 'loading') {
      const newAdjustedBaseline = calculateAdjustedBaselineForProjection();

      // 🔥 FIX: Only update if values actually changed
      setAdjustedBaselineState(prev => {
        if (deepEqual(prev, newAdjustedBaseline)) {
          if (DEBUG_MODE) console.log('⏭️ Adjusted baseline unchanged, skipping update');
          return prev;
        }
        if (DEBUG_MODE) console.log('✅ Adjusted baseline updated');
        return newAdjustedBaseline;
      });
    }
  }, [currentEstimatedBG, activeEffects, calculateAdjustedBaselineForProjection]);

  // ============================================================================
  // VELOCITY & OTHER CALCULATIONS
  // ============================================================================

  const calculateVelocityAndTrend = useCallback((sortedReadings) => {
    if (!sortedReadings || sortedReadings.length < 2) {
      return null;
    }

    const currentReading = {
      value: sortedReadings[sortedReadings.length - 1].bloodSugar,
      timestamp: sortedReadings[sortedReadings.length - 1].readingTime
    };

    const previousReading = {
      value: sortedReadings[sortedReadings.length - 2].bloodSugar,
      timestamp: sortedReadings[sortedReadings.length - 2].readingTime
    };

    const velocity = calculateGlucoseVelocity(currentReading, previousReading);
    const prediction = predictGlucoseFromVelocity(currentReading.value, velocity.velocity, 15);

    return {
      ...velocity,
      prediction: prediction
    };
  }, []);

 const buildBaselineHistoryForVisualization = useCallback(async (actualReadings, meals, insulin, constants) => {
  if (!actualReadings || actualReadings.length === 0) {
    return [];
  }

  const history = [];
  const sortedReadings = [...actualReadings]
    .filter(r => r.isActualReading && r.bloodSugar && !isNaN(r.bloodSugar))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Get absorption profiles for filtering
  const absorptionProfiles = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.meal_absorption_profiles;
  const medicationFactors = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;

  // Process each reading to calculate its baseline
  for (const reading of sortedReadings) {
    // ✅ FIX: Define readingTimestamp for this specific reading
    const readingTimestamp = TimeManager.normalize(
      reading.timestamp,
      TimeManager.precision.MINUTE
    );

    // ✅ FIX: Filter meals by THIS READING'S time, not current time
    const processedMeals = meals.map(meal => {
      const nutrition = meal.nutrition || {};

      // Calculate total carb equivalent
      let totalCarbEquiv = nutrition.totalCarbEquiv || nutrition.total_carb_equiv;
      if (!totalCarbEquiv || totalCarbEquiv <= 0) {
        const carbs = nutrition.carbs || nutrition.totalCarbs || 0;
        const protein = nutrition.protein || nutrition.totalProtein || 0;
        const fat = nutrition.fat || nutrition.totalFat || 0;
        const proteinFactor = constants?.protein_factor || 0.5;
        const fatFactor = constants?.fat_factor || 0.2;
        totalCarbEquiv = carbs + (protein * proteinFactor) + (fat * fatFactor);
      }

      // Handle various timestamp formats
      let mealTimestamp;
      if (typeof meal.timestamp === 'number') {
        mealTimestamp = meal.timestamp;
      } else if (meal.timestamp) {
        mealTimestamp = TimeManager.parseTimestamp(meal.timestamp, TimeManager.precision.MINUTE);
      } else {
        return null;
      }

      return {
        id: meal.id || meal._id,
        timestamp: mealTimestamp,
        carbEquiv: totalCarbEquiv,
        absorptionType: nutrition.absorptionType || nutrition.absorption_type ||
                        meal.absorptionType || 'medium'
      };
    }).filter(m => {
      if (!m || m.carbEquiv <= 0) return false;

      // Filter by THIS READING'S time
      const hoursSinceMealAtReading = (readingTimestamp - m.timestamp) / (3600 * 1000);
      const profile = absorptionProfiles[m.absorptionType] || absorptionProfiles['medium'];
      const maxDuration = profile.duration_hours * 1.5;

      return hoursSinceMealAtReading >= 0 && hoursSinceMealAtReading <= maxDuration;
    });

    // ✅ FIX: Filter insulin by THIS READING'S time, not current time
    const processedInsulin = insulin.map(dose => {
      let doseTimestamp;
      if (typeof dose.administrationTime === 'number') {
        doseTimestamp = dose.administrationTime;
      } else if (dose.administrationTime) {
        doseTimestamp = TimeManager.parseTimestamp(dose.administrationTime, TimeManager.precision.SECOND);
      } else if (dose.taken_at) {
        doseTimestamp = TimeManager.parseTimestamp(dose.taken_at, TimeManager.precision.SECOND);
      } else if (dose.scheduled_time) {
        doseTimestamp = TimeManager.parseTimestamp(dose.scheduled_time, TimeManager.precision.SECOND);
      } else {
        return null;
      }

      return {
        administrationTime: doseTimestamp,
        dose: dose.dose,
        insulinType: dose.medication || dose.insulinType || 'regular_insulin'
      };
    }).filter(d => {
      if (!d || !d.administrationTime || d.dose <= 0) return false;

      // Filter by THIS READING'S time
      const hoursSinceDoseAtReading = (readingTimestamp - d.administrationTime) / (3600 * 1000);
      const profile = medicationFactors[d.insulinType] || medicationFactors['regular_insulin'];

      return hoursSinceDoseAtReading >= 0 &&
             hoursSinceDoseAtReading <= (profile?.duration_hours || 8);
    });

    // Calculate baseline for this reading
    const baselineResult = calculateStableBaseline(
      reading.bloodSugar,
      readingTimestamp,
      processedMeals,
      processedInsulin,
      constants
    );

    if (baselineResult.isValid) {
      history.push({
        timestamp: reading.timestamp,
        baselineValue: baselineResult.baseline,
        actualReading: reading.bloodSugar,
        netEffectAtReading: baselineResult.netEffectAtReading,
        mealImpactAtReading: baselineResult.mealImpact,
        insulinImpactAtReading: baselineResult.insulinImpact,
        absorbedCarbsAtReading: baselineResult.absorbedCarbsAtReading,
        absorbedInsulinAtReading: baselineResult.absorbedInsulinAtReading,
        source: 'actual_reading_derived'
      });
    }
  }

  return history;
}, []);

  useEffect(() => {
    if (last24hData.length > 0 && recentMealsData.length >= 0 && recentInsulinData.length >= 0 && patientConstants) {
      const snapshot = mealInsulinSnapshotRef.current;
      const mealsToUse = snapshot.timestamp > 0 ? snapshot.meals : recentMealsData;
      const insulinToUse = snapshot.timestamp > 0 ? snapshot.insulin : recentInsulinData;

      buildBaselineHistoryForVisualization(
        last24hData,
        mealsToUse,
        insulinToUse,
        patientConstants
      ).then(history => {
        setBaselineHistory(history);
      });
    }
  }, [last24hData, recentMealsData, recentInsulinData, patientConstants, buildBaselineHistoryForVisualization]);

  // ============================================================================
  // 24H DATA GENERATION
  // ============================================================================

  const generateLast24hEstimatedData = useCallback(() => {
    if (processing24hData.current) {
      return;
    }

    if (last24hData.length === 0) {
      return;
    }

    processing24hData.current = true;

    try {
      const sortedActualReadings = [...last24hData]
        .filter(r => r.isActualReading && r.bloodSugar && !isNaN(r.bloodSugar))
        .sort((a, b) => a.readingTime - b.readingTime);

      if (sortedActualReadings.length === 0) {
        return;
      }

      const snapshot = mealInsulinSnapshotRef.current;
      const now = Date.now();
      const snapshotAge = now - snapshot.timestamp;
      const snapshotIsFresh = snapshotAge < 5000;

      // ✅ FIX (Bug #4 - infinite loop): Read currentEstimatedBG from ref
      // instead of depending on it as a useCallback dependency. Adding
      // currentEstimatedBG to the dep array caused setCurrentEstimatedBG()
      // (called below) to re-trigger this callback endlessly.
      const existingEstimatedBG = currentEstimatedBGRef.current;

      if (snapshotIsFresh && existingEstimatedBG && existingEstimatedBG.source !== 'loading') {
        const actualReadingsWithFlags = sortedActualReadings.map(reading => ({
          ...reading,
          isEstimatedLine: true
        }));

        setLast24hCombinedData(actualReadingsWithFlags);
        return;
      }

      const usingSnapshot = snapshot.timestamp > 0;
      const mealsToUse = usingSnapshot ? snapshot.meals : recentMealsData;
      const insulinToUse = usingSnapshot ? snapshot.insulin : recentInsulinData;

      const recalculateBaseline = async () => {
        const newBaseline = await calculateEnhancedBaseline(
          sortedActualReadings,
          targetGlucose,
          now,
          mealsToUse,
          insulinToUse,
          patientConstants
        );

        setCurrentEstimatedBG(newBaseline);
        baselineCalculatedRef.current = true;

        if (sortedActualReadings.length >= 2) {
          const velocity = calculateVelocityAndTrend(sortedActualReadings);
          setVelocityData(velocity);
        }

        if (dataSource === 'smbg') {
   const processedMeals = mealsToUse.map(meal => {
            const nutrition = meal.nutrition || {};
            // ✅ USE HELPER FUNCTION for dynamic calculation
            const totalCarbEquiv = calculateTotalCarbEquiv(nutrition, patientConstants);

            return {
              id: meal.id || meal._id,
              // ✅ USE TIMEMANAGER for consistent timestamp parsing
              timestamp: TimeManager.parseTimestamp(
                meal.timestamp,
                TimeManager.precision.SECOND
              ),
              carbEquiv: totalCarbEquiv,
              absorptionType: nutrition.absorptionType || nutrition.absorption_type || 'medium'
            };
          });

 const processedInsulin = insulinToUse.map(dose => ({
            // ✅ USE TIMEMANAGER for consistent timestamp parsing
            administrationTime: TimeManager.parseTimestamp(
              dose.administrationTime || dose.taken_at || dose.scheduled_time,
              TimeManager.precision.SECOND
            ),
            dose: dose.dose,
            insulinType: dose.medication || dose.insulinType
          }));
          const recommendation = recommendNextReading(
            newBaseline,
            processedMeals,
            processedInsulin,
            patientConstants
          );
          setNextReadingRecommendation(recommendation);
        }

        if (dataSource === 'cgm' && baselineHistory.length >= 20) {
          const shiftAnalysis = detectBaselineShift(baselineHistory, 24);
          setBaselineShiftData(shiftAnalysis);
        }
      };

      recalculateBaseline();

      const actualReadingsWithFlags = sortedActualReadings.map(reading => ({
        ...reading,
        isEstimatedLine: true
      }));

      setLast24hCombinedData(actualReadingsWithFlags);

    } catch (err) {
      console.error('❌ Error generating 24h estimated data:', err);
    } finally {
      processing24hData.current = false;
    }
  }, [
    last24hData,
    recentMealsData,
    recentInsulinData,
    targetGlucose,
    patientConstants,
    calculateEnhancedBaseline,
    calculateVelocityAndTrend,
    // ✅ FIX (Bug #4): currentEstimatedBG REMOVED from deps — it is now read via
    // currentEstimatedBGRef.current inside the callback so we avoid the cycle where
    // setCurrentEstimatedBG() → triggers this callback → setCurrentEstimatedBG() → ...
    dataSource,
    baselineHistory
  ]);

  useEffect(() => {
    if (last24hData.length > 0) {
      generateLast24hEstimatedData();
    }
  }, [last24hData, generateLast24hEstimatedData]);

  // ============================================================================
  // FALLBACK FOR CURRENT ESTIMATED BG
  // ============================================================================

  const currentEstimatedBGWithFallback = useMemo(() => {
    if (currentEstimatedBG && currentEstimatedBG.value) {
      return currentEstimatedBG;
    }
    return {
      value: targetGlucose,
      timestamp: Date.now(),
      source: 'loading',
      isActual: false,
      confidence: 'initializing'
    };
  }, [currentEstimatedBG, targetGlucose]);

  // ============================================================================
  // 🔥 FIX: MEMOIZED CONTEXT VALUE
  // ============================================================================

  const contextValue = useMemo(() => ({
    bloodSugarData,
    filteredData,
    estimatedBloodSugarData,
    combinedData,
    loading,
    error,
    targetGlucose,
    dateRange,
    timeScale,
    unit,
    estimationSettings,
    currentEstimatedBG: currentEstimatedBGWithFallback,

    // 🔥 FIX: Use memoized versions
    adjustedBaselineForProjection,
    activeEffects,

    last24hData,
    last24hCombinedData,
    baselineHistory,
    recentMealsData,
    recentInsulinData,
    velocityData,
    nextReadingRecommendation,
    baselineShiftData,
    dataQualityMetrics,
    dataSource,
    setDataSource,
    systemDateTime,
    currentUserLogin,
     fetchLast24hData,
  setTargetGlucose,
  setEstimationSettings,

  // 🔥 NEW: View mode support
  currentViewMode,
  handleViewModeChange,
  fetchRecentMeals,
  fetchRecentInsulin,

    calculateActiveEffects,
    calculateEnhancedBaseline,
    calculateAdjustedBaselineForProjection,
    calculateVelocityAndTrend,
    netEffectService: {
      calculateNetEffectAtTime,
      calculateBaselineFromReading,
      calculateCurrentEstimatedBG,
      calculateProjectedFinalBG,
      generateChartTimeline,
      generateDetailedEffectsTimeline,
      checkInsulinDosingSafety,
      checkMealSafety,
      calculateSafeCorrectionDose
    },
    TimeManager,
    timeContext,
    NET_EFFECT_CONSTANTS
  }), [
    // 🔥 CRITICAL: Only primitive values or stable references
    bloodSugarData,
    filteredData,
    estimatedBloodSugarData,
    combinedData,
    loading,
    error,
    targetGlucose,
    unit,


    estimationSettings,
    currentEstimatedBGWithFallback,
    adjustedBaselineForProjection, // Memoized
    activeEffects, // Memoized
    last24hData,
    last24hCombinedData,
    baselineHistory,
    recentMealsData,
    recentInsulinData,
    velocityData,
    nextReadingRecommendation,
    baselineShiftData,
    dataQualityMetrics,
    dataSource,
    fetchLast24hData,
    setTargetGlucose,
    setEstimationSettings,
    calculateActiveEffects,
    calculateEnhancedBaseline,
    calculateAdjustedBaselineForProjection,
    calculateVelocityAndTrend,
       currentViewMode,
  handleViewModeChange,
  fetchRecentMeals,
  fetchRecentInsulin
  ]);

  return (
    <BloodSugarDataContext.Provider value={contextValue}>
      {children}
    </BloodSugarDataContext.Provider>
  );
};

export default BloodSugarDataContext;

/**
 * ============================================================================
 * PERFORMANCE FIX COMPLETE - SUMMARY
 * ============================================================================
 *
 * CHANGES MADE:
 * 1. ✅ Added deepEqual helper function
 * 2. ✅ Split activeEffects into state + memoized getter
 * 3. ✅ Split adjustedBaseline into state + memoized getter
 * 4. ✅ Changed all setActiveEffects to conditional updates
 * 5. ✅ Changed all setAdjustedBaseline to conditional updates
 * 6. ✅ Wrapped context value in useMemo
 *
 * EXPECTED RESULTS:
 * - Render count: 100+/second → 1-2/minute
 * - Graph flickering: ELIMINATED
 * - Console logs: "unchanged, skipping update"
 * - Timeline calculation: Only when data changes
 *
 * DEBUG MODE:
 * Set DEBUG_MODE = true to see update logs
 * Set DEBUG_MODE = false for production (no logs)
 * ============================================================================
 */
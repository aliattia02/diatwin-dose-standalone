import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback, useRef, useContext, useMemo } from 'react';
import { useConstants } from '../contexts/ConstantsContext';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import TimeContext from '../contexts/TimeContext';
import axios from 'axios';
import { FaInfoCircle, FaChevronDown, FaChevronUp, FaFileImport, FaSync, FaHistory } from 'react-icons/fa';
import FoodSection from './FoodSection';
import {
  calculateTotalNutrients,
  calculateInsulinDose,
  getHealthFactorsBreakdown
} from './EnhancedPatientConstantsCalc';
import InsulinInput from './InsulinInput';
import BloodSugarInput from './BloodSugarInput';
import ActivityRecording from './ActivityRecording';
import TimeManager from '../utils/TimeManager';
import { MEAL_TYPES } from '../constants';
import { recommendInsulinType } from '../utils/insulinPharmacodynamics'

import './Charts/input-components.css';

const MealInput = () => {
  const timeContext = useContext(TimeContext);

  const timeUtils = useMemo(() => {
    return {
      getCurrentTime: () => TimeManager.getCurrentTimeISOString(),
      localToUTC: (localTime) => TimeManager.localToUTCISOString(localTime),
      formatDateTime: (timestamp, format) => {
        if (!timestamp) return '';
        return TimeManager.formatDateTime(timestamp);
      },
      getUserTimeZone: () => TimeManager.getUserTimeZone(),
      calculateDuration: (start, end) => TimeManager.calculateDuration(start, end),
      formatRelativeTime: (time) => TimeManager.formatRelativeTime(time),
      parseTimestamp: (timestamp) => TimeManager.parseTimestamp(timestamp)
    };
  }, []);

  const { patientConstants, loading, error, refreshConstants } = useConstants();
  // Get active effects from context - single source of truth
  const { activeEffects, adjustedBaselineForProjection, currentEstimatedBG, fetchLast24hData, fetchRecentMeals: fetchRecentMealsContext, currentViewMode } = useBloodSugarData();

  const [mealType, setMealType] = useState('');
  const [selectedFoods, setSelectedFoods] = useState([]);
  const [activitiesFromRecording, setActivitiesFromRecording] = useState([]);
  const [activityImpactFromRecording, setActivityImpactFromRecording] = useState(1.0);
  const [activityImpact, setActivityImpact] = useState(1.0);
  const [bloodSugar, setBloodSugar] = useState('');
  const [bloodSugarTimestamp, setBloodSugarTimestamp] = useState('');

  // Meal timestamp - when the meal was actually eaten (becomes 'timestamp' in DB)
  const [mealTimestamp, setMealTimestamp] = useState(timeUtils.getCurrentTime());

  const [suggestedInsulin, setSuggestedInsulin] = useState('');
  const [suggestedInsulinType, setSuggestedInsulinType] = useState('');
  const [insulinBreakdown, setInsulinBreakdown] = useState(null);
  const [insulinData, setInsulinData] = useState({
    type: '',
    dose: '',
    notes: '',
    administrationTime: ''
  });
  const [message, setMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [healthFactors, setHealthFactors] = useState(null);
  const [backendCalculation, setBackendCalculation] = useState(null);
  const [expandedCard, setExpandedCard] = useState(null);
  const [bloodSugarSource, setBloodSugarSource] = useState('direct');
  const [userTimeZone, setUserTimeZone] = useState('');
  const [importStatus, setImportStatus] = useState(null);
  const [showRecentMeals, setShowRecentMeals] = useState(false);
  const [recentMeals, setRecentMeals] = useState([]);
  const [isLoadingMeals, setIsLoadingMeals] = useState(false);

  // ── Insulin Calculation Comparison Panel state ───────────────────────────
  const [showCalcComparison, setShowCalcComparison] = useState(false);
  const [calcCompStatus, setCalcCompStatus] = useState('idle'); // idle|loading|success|error
  const [calcCompBeData, setCalcCompBeData] = useState(null);
  const [calcCompError, setCalcCompError] = useState('');
  const [calcCompLastFetched, setCalcCompLastFetched] = useState(null);

  // ✅ FIX: Snapshot of all values used in the last frontend calculation
  // This ensures the backend receives exactly the same inputs that produced the displayed suggestion
  const [lastCalculationInputs, setLastCalculationInputs] = useState(null);

  // ✅ FIX: Frozen snapshot of the last frontend breakdown so the comparison
  // panel keeps showing FE values even after the form is reset on submit.
  const [lastFrontendSnapshot, setLastFrontendSnapshot] = useState(null);

  const fileInputRef = useRef(null);

  useEffect(() => {
    setUserTimeZone(timeUtils.getUserTimeZone());
  }, [timeUtils]);

  const handleInsulinChange = (data) => {
    setInsulinData(data);
  };

  const handleActivityUpdate = (newActivities, totalImpact) => {
    setActivitiesFromRecording(newActivities.map(activity => ({
      level: activity.level,
      duration: activity.duration,
      type: activity.type,
      impact: activity.impact,
      startTime: activity.startTime,
      endTime: activity.endTime
    })));
    setActivityImpactFromRecording(totalImpact);
    setActivityImpact(totalImpact);
  };

  const calculateInsulinNeeds = useCallback(async () => {
    console.log('🔄 calculateInsulinNeeds called');

    if (selectedFoods.length === 0 || !patientConstants) {
      setSuggestedInsulin('');
      setInsulinBreakdown(null);
      setLastCalculationInputs(null); // ✅ Clear snapshot when no foods
      return;
    }

    try {
      const totalNutrition = calculateTotalNutrients(selectedFoods);

      // Get IOB and MOB from context (single source of truth)
      const activeInsulinValue = activeEffects?.iob?.total_active_insulin || 0;
      const activeMealCarbs = activeEffects?.mob?.total_active_carbs || 0;

      console.log('🩸 ACTIVE EFFECTS USED:', {
        iob: activeInsulinValue,
        mob: activeMealCarbs,
        activeEffects
      });

      // Smart BG selection logic
      let smartBloodSugar = parseFloat(bloodSugar) || 0;
      let bgSource = 'unknown';
      let bgConfidence = 'unknown';
      let minSinceReading = 0;
      let warningMsg = '';

      if (smartBloodSugar > 0) {
        // User entered actual blood sugar
        bgSource = 'actual';
        bgConfidence = 'very_high';
      } else if (
        adjustedBaselineForProjection &&
        adjustedBaselineForProjection.currentEstimatedBG !== undefined &&
        adjustedBaselineForProjection.minutesSinceReading !== undefined &&
        adjustedBaselineForProjection.minutesSinceReading <= 360
      ) {
        // ✅ FIX: Use estimated BG from adjustedBaselineForProjection regardless of confidence level.
        // 'very_low' confidence means the MODEL fit is uncertain, NOT that the BG estimate is unusable.
        // A meter reading 30 min ago with very_low model confidence still gives a far better BG
        // estimate than defaulting to target_glucose (100 mg/dL).
        smartBloodSugar = adjustedBaselineForProjection.currentEstimatedBG;
        bgSource = 'estimated';
        bgConfidence = adjustedBaselineForProjection.confidence || 'very_low';
        minSinceReading = adjustedBaselineForProjection.minutesSinceReading || 0;
      } else if (
        adjustedBaselineForProjection &&
        adjustedBaselineForProjection.source !== 'target_fallback' &&
        adjustedBaselineForProjection.currentEstimatedBG !== undefined
      ) {
        // Reading is within today's period but > 6 hours old (source === 'stale_reading').
        // calculateAdjustedBaselineForProjection already derived the correct baseline from it
        // and lowered confidence accordingly — still much better than target_glucose.
        // minutesSinceReading > 360 caused the first branch to fail, but the estimate is valid.
        smartBloodSugar = adjustedBaselineForProjection.currentEstimatedBG;
        bgSource = 'estimated';
        bgConfidence = 'very_low';
        minSinceReading = adjustedBaselineForProjection.minutesSinceReading || 0;
      } else {
        // ── NO VALID READING IN CURRENT DAILY PERIOD ──────────────────────────────
        //
        // BUG FIXED: The old secondary fallback read `currentEstimatedBG.value` directly.
        // `currentEstimatedBG` is built from `sortedReadings[0]` in BloodSugarDataContext
        // WITHOUT filtering by daily reset, so its `.value` was the raw 450 mg/dL pre-reset
        // reading. That value passed the `> 0` check and produced an 8.8-unit correction
        // against target (450 − 100) / 40, while ActiveEffectsDisplay correctly showed 140.
        //
        // When `adjustedBaselineForProjection.source === 'target_fallback'` (set inside
        // calculateAdjustedBaselineForProjection when readingIsInCurrentPeriod is false),
        // the most recent reading is from a previous daily period. Using its raw BG value
        // for correction is clinically wrong — the right behaviour is to use target_glucose,
        // which is exactly what the backend and ActiveEffectsDisplay do.
        smartBloodSugar = patientConstants.target_glucose || 100;
        bgSource = 'target_fallback';
        bgConfidence = 'very_low';
        warningMsg = 'Using target glucose — no blood sugar reading in today\'s period';
      }

      console.log('🩸 BLOOD SUGAR SELECTION:', {
        userEntered: bloodSugar,
        selectedValue: smartBloodSugar,
        selectedSource: bgSource,
        confidence: bgConfidence
      });

      // Extract cumulative values from context
      const cumulativeMealEffect = activeEffects?.netEffect?.cumulativeMealEffect || 0;
      const cumulativeInsulinEffect = activeEffects?.netEffect?.cumulativeInsulinEffect || 0;
      const cumulativeNetBaseline = activeEffects?.netEffect?.cumulativeNetBaseline || 0;
      const absorbedCarbs = adjustedBaselineForProjection?.currentAbsorbedCarbs || 0;
      const absorbedInsulin = adjustedBaselineForProjection?.currentAbsorbedInsulin || 0;
      const pendingMealRise = adjustedBaselineForProjection?.pendingMealRise || 0;
      const pendingInsulinReduction = adjustedBaselineForProjection?.pendingInsulinReduction || 0;

      const insulinCalculation = await calculateInsulinDose({
        ...totalNutrition,
        bloodSugar: smartBloodSugar,
        activities: activitiesFromRecording.map(activity => ({
          level: activity.level,
          duration: activity.duration,
          impact: activity.impact
        })),
        patientConstants,
        mealType,
        activeInsulinValue: activeInsulinValue,
        activeMealCarbs: activeMealCarbs,
        // Blood sugar metadata
        bloodSugarSource: bgSource,
        bloodSugarConfidence: bgConfidence,
        minutesSinceReading: minSinceReading,
        // Cumulative effects
        cumulativeMealEffect,
        cumulativeInsulinEffect,
        cumulativeNetBaseline,
        // Absorbed amounts
        absorbedCarbs,
        absorbedInsulin,
        // Pending effects
        pendingMealRise,
        pendingInsulinReduction,
        // Full context objects
        activeEffectsContext: activeEffects,
        adjustedBaselineContext: adjustedBaselineForProjection
      });

      setSuggestedInsulin(insulinCalculation.total);
      setInsulinBreakdown(insulinCalculation.breakdown);

      // ✅ FIX: Snapshot ALL inputs that produced this result
      // This will be used in handleSubmit to ensure backend gets identical values
      setLastCalculationInputs({
        // The blood sugar value actually used (may be estimated, not user-entered)
        bloodSugarUsed: smartBloodSugar,
        bloodSugarSource: bgSource,
        bloodSugarConfidence: bgConfidence,
        minutesSinceReading: minSinceReading,
        // IOB/MOB at calculation time
        activeInsulin: activeInsulinValue,
        activeMealCarbs: activeMealCarbs,
        // Cumulative effects at calculation time
        cumulativeMealEffect,
        cumulativeInsulinEffect,
        cumulativeNetBaseline,
        // Absorbed amounts at calculation time
        absorbedCarbs,
        absorbedInsulin,
        // Pending effects at calculation time
        pendingMealRise,
        pendingInsulinReduction,
        // Activity impact
        activityImpact: activityImpactFromRecording,
        // Health factors
        healthMultiplier: insulinCalculation.breakdown?.healthMultiplier || 1.0,
        // Timestamp of when this calculation was made
        calculatedAt: new Date().toISOString(),
      });

      if (warningMsg) {
        setWarningMessage(warningMsg);
      } else {
        setWarningMessage('');
      }

      if (mealType) {
        const recommended = recommendInsulinType(
          mealType,
          selectedFoods,
          new Date()
        );
        setSuggestedInsulinType(recommended);
      }
    } catch (error) {
      console.error('Error calculating insulin:', error);
      setMessage('Error calculating insulin needs: ' + error.message);
    }
  }, [
    selectedFoods,
    bloodSugar,
    activitiesFromRecording,
    patientConstants,
    mealType,
    activeEffects,
    adjustedBaselineForProjection,
    currentEstimatedBG
  ]);

  useEffect(() => {
    if (!loading && patientConstants && (selectedFoods.length > 0 || bloodSugar)) {
      const healthFactorsData = getHealthFactorsBreakdown(patientConstants);
      setHealthFactors(healthFactorsData);
      calculateInsulinNeeds();
    }
  }, [
    selectedFoods,
    activitiesFromRecording,
    bloodSugar,
    mealType,
    patientConstants,
    loading,
    activeEffects,
    adjustedBaselineForProjection,
    currentEstimatedBG
  ]);

  useEffect(() => {
    refreshConstants();

    const handleConstantsUpdate = () => {
      refreshConstants();
    };

    window.addEventListener('patientConstantsUpdated', handleConstantsUpdate);
    return () => {
      window.removeEventListener('patientConstantsUpdated', handleConstantsUpdate);
    };
  }, [refreshConstants]);

  const fetchRecentMeals = useCallback(async () => {
    try {
      setIsLoadingMeals(true);
      const token = localStorage.getItem('token');
      if (!token) {
        console.warn('No authentication token found');
        return;
      }

      const response = await axios.get(
        `${API_BASE_URL}/api/meals-only`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          params: {
            limit: 10
          }
        }
      );

      if (response.data && response.data.meals) {
        setRecentMeals(response.data.meals);
      }
    } catch (error) {
      console.error('Error fetching from meals-only endpoint:', error);
      setMessage('Failed to load recent meals');
    } finally {
      setIsLoadingMeals(false);
    }
  }, []);

  // ── Fetch backend comparison for the insulin calculation panel ─────────────
  const fetchCalcComparison = useCallback(async () => {
    setCalcCompStatus('loading');
    setCalcCompError('');
    try {
      const token = localStorage.getItem('token');
      if (!token) throw new Error('No authentication token');

      const tzOffset = patientConstants?.timezone_offset_minutes
        ?? -(new Date().getTimezoneOffset());

      const utcNow = new Date().toISOString();
      const resp = await axios.get(
        `${API_BASE_URL}/api/active-effects-full`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            target_time: utcNow,
            timezone_offset_minutes: tzOffset,
          },
        }
      );
      setCalcCompBeData(resp.data);
      setCalcCompLastFetched(new Date());
      setCalcCompStatus('success');
    } catch (err) {
      setCalcCompError(err.response?.data?.error || err.message || 'Unknown error');
      setCalcCompStatus('error');
    }
  }, [patientConstants]);

  const toggleCalcComparison = () => {
    setShowCalcComparison(prev => {
      if (!prev) fetchCalcComparison(); // auto-load on first open
      return !prev;
    });
  };

  const toggleRecentMeals = () => {
    setShowRecentMeals(prev => !prev);
    if (!showRecentMeals) {
      fetchRecentMeals();
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
      formData.append('type', 'meals');

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
        message: `Successfully imported ${results.meals_imported || 0} meals`,
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      await fetchRecentMeals();
      await refreshConstants();

      // Reset form
      setMealType('');
      setSelectedFoods([]);
      setActivitiesFromRecording([]);
      setBloodSugar('');
      setSuggestedInsulin('');
      setInsulinBreakdown(null);
      setLastCalculationInputs(null); // ✅ Clear snapshot on reset
      setInsulinData({
        type: '',
        dose: '',
        notes: '',
        administrationTime: ''
      });
      setSuggestedInsulinType('');
      setMealTimestamp(timeUtils.getCurrentTime());

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

  const preventFormSubmission = (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      return false;
    }
  };

  useEffect(() => {
    document.addEventListener('keydown', preventFormSubmission);
    return () => {
      document.removeEventListener('keydown', preventFormSubmission);
    };
  }, []);

  const handleFoodSelect = useCallback((food) => {
    // Starting a new meal — clear any frozen post-submit snapshot so it
    // doesn't bleed into the new calculation's comparison panel.
    setLastFrontendSnapshot(null);
    // Refresh context data so activeEffects.mob.total_active_carbs reflects the
    // current pharmacokinetic state before calculateInsulinNeeds runs.
    // Without this, a recently-logged meal may still show 100% of its carbs as
    // active (e.g. 46.6g) instead of the correctly-absorbed remainder (~20.5g),
    // causing a large MOB divergence vs the backend in the comparison panel.
    if (fetchLast24hData) fetchLast24hData();

    const foodWithPortion = {
      ...food,
      id: Date.now(),
      portion: {
        amount: food.details.serving_size?.amount || 1,
        unit: food.details.serving_size?.unit || 'serving',
        w_amount: food.details.serving_size?.w_amount || null,
        w_unit: food.details.serving_size?.w_unit || null,
        baseAmount: food.details.serving_size?.amount || 1,
        baseUnit: food.details.serving_size?.unit || 'serving',
        baseWAmount: food.details.serving_size?.w_amount || null,
        baseWUnit: food.details.serving_size?.w_unit || null,
        activeMeasurement: food.details.serving_size?.w_amount ? 'weight' : 'volume'
      }
    };
    setSelectedFoods(prev => [...prev, foodWithPortion]);
  }, [fetchLast24hData]);

  const updateFoodPortion = useCallback((foodId, newPortion) => {
    setSelectedFoods(prev => prev.map(item =>
      item.id === foodId ? { ...item, portion: newPortion } : item
    ));
  }, []);

  const removeFood = useCallback((foodId) => {
    setSelectedFoods(prev => prev.filter(item => item.id !== foodId));
  }, []);

  const handleCardClick = (cardName) => {
    setExpandedCard(expandedCard === cardName ? null : cardName);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!patientConstants) {
      setMessage('Error: Patient constants not loaded');
      return;
    }

    if (!mealType) {
      setMessage('Please select a meal type');
      return;
    }

    if (selectedFoods.length === 0) {
      setMessage('Please add at least one food item');
      return;
    }

    setIsSubmitting(true);
    setMessage('Submitting meal...');

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Authentication token not found');
      }

      const utcBloodSugarTimestamp = timeUtils.localToUTC(bloodSugarTimestamp);

      // Convert meal timestamp to UTC - this becomes the main 'timestamp' in DB
      const utcMealTimestamp = timeUtils.localToUTC(mealTimestamp);

      let activityIds = [];

      if (activitiesFromRecording.length > 0) {
        try {
          const activitiesData = {
            expectedActivities: activitiesFromRecording.map(activity => {
              const durationData = timeUtils.calculateDuration(activity.startTime, activity.endTime);
              const startTimeUTC = timeUtils.localToUTC(activity.startTime);
              const endTimeUTC = timeUtils.localToUTC(activity.endTime);

              return {
                level: activity.level,
                duration: TimeManager.hoursToTimeString(durationData.totalHours),
                expectedTime: startTimeUTC,
                startTime: startTimeUTC,
                endTime: endTimeUTC,
                impact: activity.impact,
                notes: ""
              };
            }),
            completedActivities: []
          };

          const activityResponse = await axios.post(
            `${API_BASE_URL}/api/record-activities`,
            activitiesData,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );

          if (activityResponse.data && activityResponse.data.activity_ids) {
            activityIds = activityResponse.data.activity_ids;
          }
        } catch (error) {
          console.warn('Failed to record activities separately:', error);
        }
      }

      // Only send blood sugar to backend when the user explicitly entered a value.
      // Estimated and target-fallback values are used for the frontend insulin
      // calculation display only — they must NOT create a blood_sugar DB record.
      const bloodSugarToSend = bloodSugar ? parseFloat(bloodSugar) : null;
      const bloodSugarSourceToSend = bloodSugar ? bloodSugarSource : null;

      const mealData = {
        mealType,
        recordingType: 'meal',
        mealTime: utcMealTimestamp,
        foodItems: selectedFoods.map(food => {
          const isWeightMeasurement = food.portion.activeMeasurement === 'weight';
          const amount = isWeightMeasurement ? food.portion.w_amount : food.portion.amount;
          const unit = isWeightMeasurement ? food.portion.w_unit : food.portion.unit;

          if (!amount || !unit) {
            throw new Error(`Invalid measurement for food item: ${food.name}`);
          }

          return {
            name: food.name,
            portion: {
              amount: parseFloat(amount) || 1,
              unit: unit || (isWeightMeasurement ? 'g' : 'ml'),
              measurement_type: food.portion.activeMeasurement || 'weight'
            },
            details: {
              carbs: parseFloat(food.details.carbs) || 0,
              protein: parseFloat(food.details.protein) || 0,
              fat: parseFloat(food.details.fat) || 0,
              absorption_type: food.details.absorption_type || 'medium',
              serving_size: {
                amount: food.details.serving_size?.amount || 1,
                unit: food.details.serving_size?.unit || 'serving',
                w_amount: food.details.serving_size?.w_amount,
                w_unit: food.details.serving_size?.w_unit
              }
            }
          };
        }),
        activityIds: activityIds,

        // ✅ FIX BUG 1: Send the ACTUAL blood sugar used in the frontend calculation
        bloodSugar: bloodSugarToSend,

        bloodSugarTimestamp: utcBloodSugarTimestamp,

        // ✅ FIX: Use the correct source identifier
        bloodSugarSource: bloodSugarSourceToSend,

        intendedInsulin: insulinData.dose ? parseFloat(insulinData.dose) : null,
        intendedInsulinType: insulinData.type,
        suggestedInsulinType,
        notes: insulinData.notes,

        // ✅ FIX BUG 2: Use SNAPSHOTTED values from the calculation that produced suggestedInsulin
        // Falls back to live context values if snapshot is unavailable
        calculationFactors: {
          absorptionFactor: insulinBreakdown?.absorptionFactor,
          mealTimingFactor: insulinBreakdown?.mealTimingFactor,
          activityImpact: lastCalculationInputs?.activityImpact
            ?? activityImpactFromRecording,
          activeInsulin: lastCalculationInputs?.activeInsulin
            ?? (activeEffects?.iob?.total_active_insulin || 0),
          activeMealCarbs: lastCalculationInputs?.activeMealCarbs
            ?? (activeEffects?.mob?.total_active_carbs || 0),
          healthMultiplier: lastCalculationInputs?.healthMultiplier
            ?? healthFactors?.healthMultiplier,
          medications: healthFactors?.medications?.map(med => ({
            name: med.name,
            factor: med.factor,
            status: med.status,
            hoursSinceLastDose: med.hoursSinceLastDose
          })) || [],
          conditions: healthFactors?.conditions?.map(condition => ({
            name: condition.name,
            factor: condition.factor
          })) || [],
          // Cumulative effects - from snapshot
          cumulativeMealEffect: lastCalculationInputs?.cumulativeMealEffect
            ?? (activeEffects?.netEffect?.cumulativeMealEffect || 0),
          cumulativeInsulinEffect: lastCalculationInputs?.cumulativeInsulinEffect
            ?? (activeEffects?.netEffect?.cumulativeInsulinEffect || 0),
          cumulativeNetBaseline: lastCalculationInputs?.cumulativeNetBaseline
            ?? (activeEffects?.netEffect?.cumulativeNetBaseline || 0),
          // Absorbed amounts - from snapshot
          absorbedCarbs: lastCalculationInputs?.absorbedCarbs
            ?? (adjustedBaselineForProjection?.currentAbsorbedCarbs || 0),
          absorbedInsulin: lastCalculationInputs?.absorbedInsulin
            ?? (adjustedBaselineForProjection?.currentAbsorbedInsulin || 0),
          // Pending effects - from snapshot
          pendingMealRise: lastCalculationInputs?.pendingMealRise
            ?? (adjustedBaselineForProjection?.pendingMealRise || 0),
          pendingInsulinReduction: lastCalculationInputs?.pendingInsulinReduction
            ?? (adjustedBaselineForProjection?.pendingInsulinReduction || 0),
          // Blood sugar metadata - from snapshot
          // ✅ FIX 1: Always send the BG actually used in the frontend calc
          // (may be estimated, not user-typed) so backend can reproduce correction.
          bloodSugarUsed: lastCalculationInputs?.bloodSugarUsed ?? null,
          bloodSugarSource: lastCalculationInputs?.bloodSugarSource
            ?? (insulinBreakdown?.bloodSugarSource || 'unknown'),
          bloodSugarConfidence: lastCalculationInputs?.bloodSugarConfidence
            ?? (insulinBreakdown?.bloodSugarConfidence || 'unknown'),
          minutesSinceReading: lastCalculationInputs?.minutesSinceReading
            ?? (insulinBreakdown?.minutesSinceReading || 0)
        }
      };

      if (insulinData.dose && insulinData.type) {
        const administrationTime = insulinData.administrationTime ?
          timeUtils.localToUTC(insulinData.administrationTime) :
          utcMealTimestamp;

        mealData.medicationLog = {
          is_insulin: true,
          dose: parseFloat(insulinData.dose),
          medication: insulinData.type,
          scheduled_time: administrationTime,
          notes: insulinData.notes,
          meal_context: {
            meal_type: mealType,
            blood_sugar: bloodSugarToSend,
            suggested_dose: suggestedInsulin ? parseFloat(suggestedInsulin) : null,
          }
        };
      }

      const response = await axios.post(
        `${API_BASE_URL}/api/meal`,
        mealData,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      setBackendCalculation(response.data.insulinCalculation);
      setMessage('Meal logged successfully!');

      // ✅ FIX: Freeze the current frontend breakdown BEFORE clearing the form.
      // Also add the submitted meal's carb equiv to activeMealCarbs so the frozen
      // FE MOB matches what the backend returns (backend always includes the
      // newly saved meal in its MOB calculation).
      const submittedMealCarbs = insulinBreakdown?.totalCarbEquiv ?? 0;
      const carbToBgFactor = patientConstants?.carb_to_bg_factor ?? 4.0;
      const updatedCalcInputs = lastCalculationInputs
        ? {
            ...lastCalculationInputs,
            activeMealCarbs: (lastCalculationInputs.activeMealCarbs ?? 0) + submittedMealCarbs,
            pendingMealRise:
              ((lastCalculationInputs.activeMealCarbs ?? 0) + submittedMealCarbs) * carbToBgFactor,
          }
        : lastCalculationInputs;
      setLastFrontendSnapshot({
        insulinBreakdown,
        suggestedInsulin,
        lastCalculationInputs: updatedCalcInputs,
      });

      // Reset form
      setMealType('');
      setSelectedFoods([]);
      setActivitiesFromRecording([]);
      setBloodSugar('');
      setSuggestedInsulin('');
      setInsulinBreakdown(null);
      setLastCalculationInputs(null); // ✅ Clear snapshot on reset
      // NOTE: lastFrontendSnapshot is intentionally NOT cleared here —
      // it was just set above and must survive the form reset so the
      // comparison panel keeps showing FE values after submit.
      setInsulinData({
        type: '',
        dose: '',
        notes: '',
        administrationTime: ''
      });
      setSuggestedInsulinType('');
      setMealTimestamp(timeUtils.getCurrentTime());

      if (insulinData.dose && insulinData.type) {
        await refreshConstants();
      }
      await fetchRecentMeals();

      // Re-sync context: bypass the meal cache so the newly posted meal
      // is picked up immediately, then pull fresh blood-sugar readings
      // which triggers calculateActiveEffects with the new data.
      await fetchRecentMealsContext(currentViewMode, true);
      fetchLast24hData();

      // ✅ FIX 3: Always open and auto-fetch the comparison panel after submit
      // so the user sees BE vs FE alignment instantly without clicking REFRESH.
      // Small delay gives the backend time to finish persisting before we query.
      setShowCalcComparison(true);
      setCalcCompStatus('loading');
      setTimeout(() => { fetchCalcComparison(); }, 800);

    } catch (error) {
      console.error('Error submitting meal:', error);
      const errorMessage = error.response?.data?.error || error.message;
      setMessage(`Error: ${errorMessage}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="meal-loading">Loading patient constants...</div>;
  }

  if (error) {
    return <div className="meal-error">Error loading patient data: {error}</div>;
  }

    return (
    <div className="meal-container">
      <div className="meal-header">
        <h2 className="meal-title">Log Your Meal</h2>
        <div className="meal-action-buttons">
          <button
            type="button"
            className="meal-icon-button meal-refresh-btn"
            onClick={fetchRecentMeals}
            title="Refresh meals"
            disabled={isSubmitting}
          >
            <FaSync className={isLoadingMeals ? "meal-spin" : ""} />
          </button>
          <button
            type="button"
            className="meal-icon-button meal-history-btn"
            onClick={toggleRecentMeals}
            title={showRecentMeals ? "Hide recent meals" : "Show recent meals"}
          >
            <FaHistory />
          </button>
          <button
            type="button"
            className="meal-icon-button meal-import-btn"
            onClick={handleImportClick}
            title="Import meals"
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

      <div className="meal-timezone-info">
        Your timezone: {userTimeZone}
        <span className="meal-timezone-note"> (all times stored in UTC but displayed in your local timezone)</span>
      </div>

      {importStatus && (
        <div className={`meal-message meal-msg-${importStatus.type}`}>
          <FaInfoCircle className="meal-message-icon" />
          <div className="meal-message-content">
            <h4>{importStatus.message}</h4>
            {importStatus.details && (
              <pre className="meal-message-details">{importStatus.details}</pre>
            )}
          </div>
        </div>
      )}

      {showRecentMeals && (
        <div className="meal-recent-meals">
          <h3>Recent Meals ({recentMeals.length})</h3>
          {isLoadingMeals ? (
            <div className="meal-loading-meals">Loading recent meals...</div>
          ) : recentMeals.length > 0 ? (
            <div className="meal-meals-list">
              {recentMeals.map((meal) => (
                <div key={meal.id} className="meal-item">
                  <div className="meal-item-header">
                    <span className="meal-type">
                      {meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1)}
                    </span>
                    <span className="meal-timestamp">
                      {timeUtils.formatDateTime(meal.timestamp)}
                    </span>
                  </div>
                  <div className="meal-details">
                    <div className="meal-food-items">
                      {meal.foodItems.length > 0 ? (
                        <div>
                          {meal.foodItems.slice(0, 3).map((food, idx) => (
                            <span key={idx} className="meal-food-item">
                              {food.name}
                            </span>
                          ))}
                          {meal.foodItems.length > 3 && (
                            <span className="meal-more-foods">
                              +{meal.foodItems.length - 3} more
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="meal-no-foods">No food items</span>
                      )}
                    </div>
                    <div className="meal-nutrition">
                      <span>{meal.nutrition?.carbs || 0}g carbs</span>
                      <span>{meal.nutrition?.protein || 0}g protein</span>
                      <span>{meal.nutrition?.fat || 0}g fat</span>
                    </div>

                    {meal.calculation_summary && (
                      <div className="meal-calculation-summary">
                        <div className="meal-calc-row">
                          <span className="meal-calc-label">Base Units:</span>
                          <span className="meal-calc-value">{meal.calculation_summary.base_insulin?.toFixed(1) || 'N/A'}</span>
                        </div>

                        {meal.calculation_summary.adjustment_factors && (
                          <div className="meal-calc-row">
                            <span className="meal-calc-label">Adjustments:</span>
                            <span className="meal-calc-value">
                              <span className="meal-adj-factor">
                                Abs: {((meal.calculation_summary.adjustment_factors.absorption_rate - 1) * 100).toFixed(0)}%
                              </span>
                              <span className="meal-adj-factor">
                                Timing: {((meal.calculation_summary.adjustment_factors.meal_timing - 1) * 100).toFixed(0)}%
                              </span>
                            </span>
                          </div>
                        )}

                        {meal.calculation_summary.meal_only_suggested_insulin !== undefined && (
                          <div className="meal-calc-row meal-suggested-insulin-row">
                            <span className="meal-calc-label">Meal Only Suggested Insulin:</span>
                            <span className="meal-suggested-value">
                              {meal.calculation_summary.meal_only_suggested_insulin.toFixed(1)} units
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="meal-no-meals">No recent meals found</p>
          )}
          <div className="meal-meals-footer">
            <span className="meal-view-all-meals">
              <a href="#" onClick={(e) => {
                e.preventDefault();
                window.location.href = '/meal-history';
              }}>
                View all meals →
              </a>
            </span>
          </div>
        </div>
      )}

      <form className="meal-form" onSubmit={handleSubmit} onKeyDown={preventFormSubmission}>
        <div className="meal-form-field">
          <label htmlFor="mealType">Meal Type</label>
          <select
            id="mealType"
            value={mealType}
            onChange={(e) => setMealType(e.target.value)}
            required
          >
            <option value="">Select type</option>
            {MEAL_TYPES.map(type => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
        </div>

        {/* Meal Timestamp Input - When the meal was eaten */}
        <div className="meal-form-field">
          <label htmlFor="mealTimestamp">When did you eat this meal?</label>
          <input
            id="mealTimestamp"
            type="datetime-local"
            value={mealTimestamp}
            onChange={(e) => setMealTimestamp(e.target.value)}
            required
            className="meal-time-input"
            disabled={isSubmitting}
          />
        </div>

        <div className="meal-form-section">
          <h3 className="meal-subtitle">Add Foods</h3>
          <FoodSection
            selectedFoods={selectedFoods}
            onFoodSelect={handleFoodSelect}
            onUpdatePortion={updateFoodPortion}
            onRemoveFood={removeFood}
          />
        </div>

        <div className="meal-activity-section">
          <h3 className="meal-subtitle">Activities</h3>
          <ActivityRecording
            standalone={false}
            onActivityUpdate={handleActivityUpdate}
            initialActivities={activitiesFromRecording}
          />
        </div>

        <div className="meal-measurement-section">
          <div className="meal-form-field">
            <label htmlFor="bloodSugar">Blood Sugar Level</label>
            <BloodSugarInput
              initialValue={bloodSugar}
              onBloodSugarChange={(value, timestamp) => {
                setBloodSugar(value);
                setBloodSugarTimestamp(timestamp || new Date().toISOString());
                setBloodSugarSource('direct');
              }}
              disabled={isSubmitting}
              standalone={false}
              className="meal-input-blood-sugar"
              useTimeContext={false}
            />
            {bloodSugarTimestamp && (
              <div className="meal-timestamp-display">
                Reading time: {timeUtils.formatDateTime(bloodSugarTimestamp)}
              </div>
            )}
          </div>
        </div>

        <div className="meal-form-field">
          <InsulinInput
            isStandalone={false}
            initialInsulin={insulinData.type}
            initialDose={insulinData.dose}
            onInsulinChange={handleInsulinChange}
            suggestedInsulin={suggestedInsulin}
            suggestedInsulinType={suggestedInsulinType}
            className="meal-input-insulin"
          />
        </div>

        {selectedFoods.length > 0 && insulinBreakdown && (
          <div className="meal-section-card">
            <div className="meal-section-header">
              <h3 className="meal-section-title">
                Insulin Calculation Summary
                <div className="meal-tooltip">
                  <FaInfoCircle className="meal-info-icon"/>
                  <span className="meal-tooltip-text">
                    Click on any card to see detailed breakdown
                  </span>
                </div>
              </h3>
            </div>

            <div className="meal-breakdown-grid">
              <div
                className={`meal-breakdown-card ${expandedCard === 'base' ? 'meal-expanded' : ''}`}
                onClick={() => handleCardClick('base')}
              >
                <div className="meal-breakdown-header">
                  <div className="meal-header-content">
                    <span>Base Insulin Needs</span>
                    {expandedCard === 'base' ? <FaChevronUp/> : <FaChevronDown/>}
                  </div>
                  <div className="meal-breakdown-value">{insulinBreakdown.baseInsulin.toFixed(1)} units</div>
                </div>

                {expandedCard === 'base' && (
                  <div className="meal-expanded-content">
                    <ul>
                      <li>Carbohydrates: {insulinBreakdown.carbsActual.toFixed(1)}g</li>
                      <li>Protein equivalent: {insulinBreakdown.proteinCarbEquiv.toFixed(1)}g</li>
                      <li>Fat equivalent: {insulinBreakdown.fatCarbEquiv.toFixed(1)}g</li>
                      <li className="meal-summary-line">
                        Total carb equivalent: {insulinBreakdown.totalCarbEquiv.toFixed(1)}g
                      </li>
                      <li className="meal-summary-line">
                        Base insulin: {insulinBreakdown.baseInsulin.toFixed(1)} units
                        <div className="meal-formula-explanation">
                          <small>(Total carb equivalent ÷ Insulin-to-carb ratio)</small>
                        </div>
                      </li>
                    </ul>
                  </div>
                )}
              </div>

              <div
                className={`meal-breakdown-card ${expandedCard === 'activity' ? 'meal-expanded' : ''}`}
                onClick={() => handleCardClick('activity')}
              >
                <div className="meal-breakdown-header">
                  <div className="meal-header-content">
                    <span>Activity Impact</span>
                    {expandedCard === 'activity' ? <FaChevronUp/> : <FaChevronDown/>}
                  </div>
                  <div className={`meal-breakdown-value ${
                    activityImpactFromRecording < 1 ? 'meal-impact-negative' : 'meal-impact-positive'
                  }`}>
                    {((activityImpactFromRecording - 1) * 100).toFixed(1)}%
                    {activityImpactFromRecording !== 1 && (activityImpactFromRecording > 1 ? ' Increase' : ' Decrease')}
                  </div>
                </div>

                {expandedCard === 'activity' && activitiesFromRecording.length > 0 && (
                  <div className="meal-expanded-content">
                    {activitiesFromRecording.map((activity, index) => (
                      <div key={index} className="meal-activity-detail">
                        <span>Activity {index + 1}:</span>
                        <span>Level: {activity.level}</span>
                        <span>Duration: {activity.duration}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div
                className={`meal-breakdown-card ${expandedCard === 'adjustment' ? 'meal-expanded' : ''}`}
                onClick={() => handleCardClick('adjustment')}
              >
                <div className="meal-breakdown-header">
                  <div className="meal-header-content">
                    <span>Pharmacodynamic Adjustments</span>
                    {expandedCard === 'adjustment' ? <FaChevronUp/> : <FaChevronDown/>}
                  </div>
                  <div className="meal-breakdown-value">
                    {[
                      insulinBreakdown.absorptionFactor,
                      insulinBreakdown.mealTimingFactor,
                      insulinBreakdown.timeOfDayFactor,
                      insulinBreakdown.activityImpact
                    ].some(factor => factor !== 1) ? (
                      <span className="meal-value-highlight">
                        Adjustments applied: {insulinBreakdown.adjustedInsulin.toFixed(1)} units
                      </span>
                    ) : '0.0% (no adjustment)'}
                  </div>
                </div>

                {expandedCard === 'adjustment' && (
                  <div className="meal-expanded-content">
                    <ul>
                      <li>Absorption rate: <span className="meal-value-highlight">
                        {((insulinBreakdown.absorptionFactor - 1) * 100).toFixed(1)}%
                        {insulinBreakdown.absorptionFactor > 1
                          ? ` (+${((insulinBreakdown.absorptionFactor - 1) * 100).toFixed(1)}% increase)`
                          : insulinBreakdown.absorptionFactor < 1
                            ? ` (${((insulinBreakdown.absorptionFactor - 1) * 100).toFixed(1)}% decrease)`
                            : ' (no adjustment)'}
                      </span></li>
                      <li>Meal timing: <span className="meal-value-highlight">
                        {((insulinBreakdown.mealTimingFactor - 1) * 100).toFixed(1)}%
                        {insulinBreakdown.mealTimingFactor > 1
                          ? ` (+${((insulinBreakdown.mealTimingFactor - 1) * 100).toFixed(1)}% increase)`
                          : insulinBreakdown.mealTimingFactor < 1
                            ? ` (${((insulinBreakdown.mealTimingFactor - 1) * 100).toFixed(1)}% decrease)`
                            : ' (no adjustment)'}
                      </span></li>
                      <li>Activity impact: <span className="meal-value-highlight">
                        {((insulinBreakdown.activityImpact - 1) * 100).toFixed(1)}%
                        {insulinBreakdown.activityImpact > 1
                          ? ` (+${((insulinBreakdown.activityImpact - 1) * 100).toFixed(1)}% increase)`
                          : insulinBreakdown.activityImpact < 1
                            ? ` (${((insulinBreakdown.activityImpact - 1) * 100).toFixed(1)}% decrease)`
                            : ' (no adjustment)'}
                      </span></li>
                      <li className="meal-summary-line">
                        Adjusted Insulin: <span className="meal-value-highlight">
                          {insulinBreakdown.adjustedInsulin.toFixed(1)}
                        </span> units
                        <div className="meal-formula-explanation">
                          <small>(Base insulin × Absorption × Meal timing × Activity factor)</small>
                        </div>
                      </li>
                    </ul>
                  </div>
                )}
              </div>

              {healthFactors && healthFactors.healthMultiplier !== 1 && (
                <div
                  className={`meal-breakdown-card ${expandedCard === 'health' ? 'meal-expanded' : ''}`}
                  onClick={() => handleCardClick('health')}
                >
                  <div className="meal-breakdown-header">
                    <div className="meal-header-content">
                      <span>Pharmacokinetics Adjustments</span>
                      {expandedCard === 'health' ? <FaChevronUp/> : <FaChevronDown/>}
                    </div>
                    <div className={`meal-breakdown-value ${
                      healthFactors.healthMultiplier < 1 ? 'meal-impact-negative' : 'meal-impact-positive'
                    }`}>
                      {((healthFactors.healthMultiplier - 1) * 100).toFixed(1)}%
                      {healthFactors.healthMultiplier > 1 ? ' Increase' : ' Decrease'}
                    </div>
                  </div>

                  {expandedCard === 'health' && (
                    <div className="meal-expanded-content">
                      {healthFactors.conditions.length > 0 && (
                        <div className="meal-health-section">
                          <h4>Active Conditions:</h4>
                          <ul>
                            {healthFactors.conditions.map(condition => (
                              <li key={condition.name}>
                                {condition.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:
                                {condition.percentage}%
                                {condition.factor > 1
                                  ? ` (+${condition.percentage}% increase)`
                                  : ` (${condition.percentage}% decrease)`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {healthFactors.medications.length > 0 && (
                        <div className="meal-health-section">
                          <h4>Medications:</h4>
                          {healthFactors.medications.map(med => (
                            <div key={med.name} className="meal-medication-effect">
                              <h5>{med.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</h5>
                              <div className="meal-effect-details">
                                <p>Status: {med.status}</p>
                                {med.lastDose && <p>Last dose: {med.lastDose}</p>}
                                {med.hoursSinceLastDose && <p>Hours since last dose: {med.hoursSinceLastDose.toFixed(1)}h</p>}
                                <p>Current effect: {((med.factor - 1) * 100).toFixed(1)}%
                                  {med.factor > 1 ? ' increase' : ' decrease'}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Current State Correction - Merged Card */}
              <div
                className={`meal-breakdown-card ${expandedCard === 'current_state' ? 'meal-expanded' : ''}`}
                onClick={() => handleCardClick('current_state')}
              >
                <div className="meal-breakdown-header">
                  <div className="meal-header-content">
                    <span>Current State Correction</span>
                    {expandedCard === 'current_state' ? <FaChevronUp/> : <FaChevronDown/>}
                  </div>
                  <div className="meal-breakdown-value">
                    {insulinBreakdown.correctionInsulin.toFixed(1)} units
                  </div>
                </div>

                {expandedCard === 'current_state' && (
                  <div className="meal-expanded-content">
                    <div className="meal-state-explanation">
                      <p><strong>📊 Accounts for your current blood sugar position</strong></p>
                      <p className="meal-subtext">This includes all absorbed effects already in your bloodstream</p>
                    </div>
                    <ul>
                      <li>
                        Current BG: <span className="meal-value-highlight">{insulinBreakdown.bloodSugarUsed?.toFixed(0) || 0} mg/dL</span>
                        {insulinBreakdown.bloodSugarSource === 'estimated' && (
                          <span className="meal-info-badge">Estimated</span>
                        )}
                        {insulinBreakdown.bloodSugarSource === 'actual' && (
                          <span className="meal-success-badge">Actual Reading</span>
                        )}
                      </li>
                      <li>Target BG: {patientConstants?.target_glucose || 100} mg/dL</li>
                      <li>Correction Factor: 1 unit per {patientConstants?.correction_factor || 50} mg/dL</li>
                      <li className="meal-summary-line">
                        <strong>Correction Needed: <span className="meal-value-highlight">
                          {insulinBreakdown.correctionInsulin.toFixed(1)} units
                        </span></strong>
                        <div className="meal-formula-explanation">
                          <small>({insulinBreakdown.bloodSugarUsed?.toFixed(0) || 0} - {patientConstants?.target_glucose || 100}) / {patientConstants?.correction_factor || 50}</small>
                        </div>
                      </li>
                    </ul>

                    {insulinBreakdown.bloodSugarSource === 'estimated' && (
                      <div className="meal-info-box">
                        <small>
                          <strong>ℹ️ Using Estimated BG</strong><br/>
                          Confidence: {insulinBreakdown.bloodSugarConfidence}<br/>
                          {insulinBreakdown.minutesSinceReading} minutes since last reading<br/>
                          Estimate includes absorbed carbs and insulin
                        </small>
                      </div>
                    )}
                    {insulinBreakdown.bloodSugarSource === 'target_fallback' && (
                      <div className="meal-warning-box">
                        <small>
                          <strong>⚠️ Using Target Glucose</strong><br/>
                          No recent blood sugar reading available<br/>
                          Consider checking your BG before dosing
                        </small>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Active Effects - Future Adjustments */}
              {(insulinBreakdown.activeInsulin > 0 || insulinBreakdown.activeMealCarbs > 0) && (
                <div
                  className={`meal-breakdown-card meal-active-insulin-card ${expandedCard === 'active' ? 'meal-expanded' : ''}`}
                  onClick={() => handleCardClick('active')}
                >
                  <div className="meal-breakdown-header">
                    <div className="meal-header-content">
                      <span>Active Effects Adjustment</span>
                      {expandedCard === 'active' ? <FaChevronUp/> : <FaChevronDown/>}
                    </div>
                    <div className="meal-breakdown-value">
                      -{(insulinBreakdown.activeInsulin + (insulinBreakdown.mobInsulinEquivalent || 0)).toFixed(1)} units
                    </div>
                  </div>

                  {expandedCard === 'active' && (
                    <div className="meal-expanded-content">
                      <div className="meal-state-explanation">
                        <p><strong>⏳ Accounts for insulin and carbs still working</strong></p>
                        <p className="meal-subtext">These haven't raised or lowered your BG yet, but will in the future</p>
                      </div>
                      <ul>
                        {insulinBreakdown.activeInsulin > 0 && (
                          <li className="meal-active-insulin-item">
                            <strong>💉 Active Insulin (IOB):</strong> {insulinBreakdown.activeInsulin.toFixed(1)} units
                            <div className="meal-effect-explanation">
                              <small>Still working → will lower BG by ~{(insulinBreakdown.activeInsulin * (patientConstants?.correction_factor || 50)).toFixed(0)} mg/dL</small>
                            </div>
                          </li>
                        )}
                        {insulinBreakdown.activeMealCarbs > 0 && (
                          <li className="meal-active-meal-item">
                            <strong>🍽️ Active Meal Carbs (MOB):</strong> {insulinBreakdown.activeMealCarbs.toFixed(1)}g
                            <div className="meal-effect-explanation">
                              <small>
                                Still digesting → will raise BG by ~{(insulinBreakdown.activeMealCarbs * (patientConstants?.carb_to_bg_factor || 4)).toFixed(0)} mg/dL<br/>
                                Insulin equivalent: {insulinBreakdown.mobInsulinEquivalent.toFixed(1)} units
                              </small>
                            </div>
                          </li>
                        )}
                        <li className="meal-summary-line">
                          <strong>Total Reduction: <span className="meal-value-negative">
                            -{(insulinBreakdown.activeInsulin + (insulinBreakdown.mobInsulinEquivalent || 0)).toFixed(1)} units
                          </span></strong>
                          <div className="meal-formula-explanation">
                            <small>Prevents insulin stacking and accounts for pending carb absorption</small>
                          </div>
                        </li>
                      </ul>

                      <div className="meal-info-box">
                        <small>
                          <strong>💡 Why we subtract these:</strong><br/>
                          • IOB will lower your BG soon, so you need less insulin now<br/>
                          • MOB will raise your BG soon, acting like insulin would<br/>
                          • This prevents dangerous insulin stacking
                        </small>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div
                className={`meal-breakdown-card ${expandedCard === 'final' ? 'meal-expanded' : ''}`}
                onClick={() => handleCardClick('final')}
              >
                <div className="meal-breakdown-header">
                  <div className="meal-header-content">
                    <span>Suggested Insulin Dose</span>
                    {expandedCard === 'final' ? <FaChevronUp/> : <FaChevronDown/>}
                  </div>
                  <div className="meal-breakdown-value">{suggestedInsulin} units</div>
                </div>

                {expandedCard === 'final' && (
                  <div className="meal-expanded-content">
                    <div className="meal-calculation-breakdown">
                      <h4>📋 Complete Calculation:</h4>

                      <div className="meal-calc-section">
                        <p className="meal-calc-step">
                          <span className="meal-step-number">1.</span>
                          <strong>Base Insulin for Meal:</strong> {insulinBreakdown.adjustedInsulin.toFixed(1)} units
                        </p>
                        <div className="meal-calc-detail">
                          <small>({insulinBreakdown.totalCarbEquiv?.toFixed(1) || 0}g carb equiv ÷ {patientConstants?.insulin_to_carb_ratio || 10} ratio)</small>
                        </div>
                      </div>

                      {insulinBreakdown.correctionInsulin !== 0 && (
                        <div className="meal-calc-section">
                          <p className="meal-calc-step">
                            <span className="meal-step-number">2.</span>
                            <strong>Current State Correction:</strong> {insulinBreakdown.correctionInsulin >= 0 ? '+' : ''}{insulinBreakdown.correctionInsulin.toFixed(1)} units
                          </p>
                          <div className="meal-calc-detail">
                            <small>Current BG ({insulinBreakdown.bloodSugarUsed?.toFixed(0) || 0}) already includes absorbed carbs & insulin</small>
                          </div>
                        </div>
                      )}

                      <div className="meal-calc-divider"></div>

                      <div className="meal-calc-section">
                        <p className="meal-calc-subtotal">
                          <strong>Subtotal:</strong> {insulinBreakdown.preActiveTotal.toFixed(1)} units
                        </p>
                      </div>

                      {(insulinBreakdown.activeInsulin > 0 || insulinBreakdown.activeMealCarbs > 0) && (
                        <>
                          <div className="meal-calc-section">
                            <p className="meal-calc-step">
                              <span className="meal-step-number">3.</span>
                              <strong>Active Effects Adjustment:</strong>
                            </p>
                            {insulinBreakdown.activeInsulin > 0 && (
                              <div className="meal-calc-item">
                                <span>• Active Insulin (IOB):</span>
                                <span className="meal-value-negative">-{insulinBreakdown.activeInsulin.toFixed(1)} units</span>
                              </div>
                            )}
                            {insulinBreakdown.activeMealCarbs > 0 && (
                              <div className="meal-calc-item">
                                <span>• Active Meal Carbs (MOB):</span>
                                <span className="meal-value-negative">-{insulinBreakdown.mobInsulinEquivalent.toFixed(1)} units</span>
                              </div>
                            )}
                            <div className="meal-calc-detail">
                              <small>These will affect BG in the future, so we reduce dose now</small>
                            </div>
                          </div>

                          <div className="meal-calc-divider"></div>

                          <div className="meal-calc-section">
                            <p className="meal-calc-subtotal">
                              <strong>After Active Adjustments:</strong> {insulinBreakdown.postActiveTotal.toFixed(1)} units
                            </p>
                          </div>
                        </>
                      )}

                      {insulinBreakdown.healthMultiplier !== 1.0 && (
                        <div className="meal-calc-section">
                          <p className="meal-calc-step">
                            <span className="meal-step-number">4.</span>
                            <strong>Health Factor Multiplier:</strong> ×{insulinBreakdown.healthMultiplier.toFixed(2)}
                          </p>
                          <div className="meal-calc-detail">
                            <small>Accounts for illness, medications, or other health factors</small>
                          </div>
                        </div>
                      )}

                      <div className="meal-calc-divider meal-calc-divider-thick"></div>

                      <div className="meal-calc-final">
                        <p className="meal-calc-result">
                          <strong>FINAL DOSE:</strong>
                          <span className="meal-final-value">{suggestedInsulin} units</span>
                        </p>
                        <div className="meal-formula-explanation">
                          <small>
                            Formula: ({insulinBreakdown.adjustedInsulin.toFixed(1)}
                            {insulinBreakdown.correctionInsulin !== 0 ? ` + ${insulinBreakdown.correctionInsulin.toFixed(1)}` : ''}
                            {insulinBreakdown.activeInsulin > 0 ? ` - ${insulinBreakdown.activeInsulin.toFixed(1)}` : ''}
                            {insulinBreakdown.mobInsulinEquivalent > 0 ? ` - ${insulinBreakdown.mobInsulinEquivalent.toFixed(1)}` : ''})
                            {insulinBreakdown.healthMultiplier !== 1.0 ? ` × ${insulinBreakdown.healthMultiplier.toFixed(2)}` : ''}
                            {' = '}{suggestedInsulin} units
                          </small>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {selectedFoods.length > 0 && patientConstants && (
          <div className="meal-timing-guidelines">
            <h4>Insulin Timing Guidelines</h4>
            {selectedFoods.map(food => {
              const absorptionType = food.details.absorption_type || 'medium';
              const guideline = patientConstants.insulin_timing_guidelines[absorptionType];
              return (
                <p key={food.id}>
                  {food.name}: {guideline?.description || 'Take insulin as usual'}
                </p>
              );
            })}
          </div>
        )}

        <button
          className="meal-submit-button"
          type="submit"
          disabled={loading || !patientConstants || isSubmitting}
        >
          {isSubmitting ? 'Submitting...' : 'Log Meal'}
        </button>
      </form>

      {message && (
        <div className={`meal-message ${message.includes('Error') ? 'meal-msg-error' : 'meal-msg-success'}`}>
          {message}
        </div>
      )}

      {warningMessage && (
        <div className="meal-message meal-msg-warning">
          ⚠️ {warningMessage}
        </div>
      )}

      {/* ================================================================
          🔬 INSULIN DOSE: FRONTEND ↔ BACKEND COMPARISON PANEL
          ================================================================ */}
      <MealCalcComparisonPanel
        insulinBreakdown={insulinBreakdown}
        suggestedInsulin={suggestedInsulin}
        activeEffects={activeEffects}
        adjustedBaselineForProjection={adjustedBaselineForProjection}
        patientConstants={patientConstants}
        lastCalculationInputs={lastCalculationInputs}
        selectedFoods={selectedFoods}
        show={showCalcComparison}
        status={calcCompStatus}
        beData={calcCompBeData}
        backendMealCalc={backendCalculation}
        frontendSnapshot={lastFrontendSnapshot}
        errorMsg={calcCompError}
        lastFetched={calcCompLastFetched}
        onToggle={toggleCalcComparison}
        onRefresh={fetchCalcComparison}
      />
    </div>
  );
};

// ============================================================================
// COMPARISON PANEL HELPERS
// ============================================================================

const MEAL_CALC_DIFF = { EXACT: 1.0, CLOSE: 5.0 };

function mealCalcClassify(a, b) {
  if (a == null || b == null) return { icon: '⬜', color: '#aaa', bg: '#f5f5f5', label: 'N/A' };
  const d = Math.abs(a - b);
  if (d <= MEAL_CALC_DIFF.EXACT) return { icon: '✅', color: '#2e7d32', bg: '#e8f5e9', label: `Δ${d.toFixed(2)}` };
  if (d <= MEAL_CALC_DIFF.CLOSE) return { icon: '🟡', color: '#e65100', bg: '#fff3e0', label: `Δ${d.toFixed(2)}` };
  return { icon: '🔴', color: '#c62828', bg: '#ffebee', label: `Δ${d.toFixed(2)}` };
}

function McRow({ label, sublabel, feVal, beVal, unit = '', precision = 2 }) {
  const fe = typeof feVal === 'number' ? feVal : null;
  const be = typeof beVal === 'number' ? beVal : null;
  const { icon, color, bg, label: diffLabel } = mealCalcClassify(fe, be);
  const fmt = v => v != null ? `${v.toFixed(precision)}${unit}` : '—';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 130px 130px 90px',
      alignItems: 'center',
      gap: '8px',
      padding: '7px 12px',
      borderBottom: '1px solid #e0e0e0',
      backgroundColor: bg,
      fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
      fontSize: '11px',
    }}>
      <div>
        <div style={{ fontWeight: 600, color: '#333' }}>{label}</div>
        {sublabel && <div style={{ color: '#888', fontSize: '10px', marginTop: '2px' }}>{sublabel}</div>}
      </div>
      <div style={{ textAlign: 'right', color: '#1565c0', fontWeight: 600 }}>{fmt(fe)}</div>
      <div style={{ textAlign: 'right', color: '#6a1b9a', fontWeight: 600 }}>{fmt(be)}</div>
      <div style={{ textAlign: 'center', color, fontWeight: 700 }}>
        <span style={{ fontSize: '14px' }}>{icon}</span>
        <div style={{ fontSize: '9px', marginTop: '2px' }}>{diffLabel}</div>
      </div>
    </div>
  );
}

function McSection({ icon, title }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 130px 130px 90px',
      gap: '8px',
      padding: '9px 12px 5px',
      backgroundColor: '#263238',
      color: '#eceff1',
      fontFamily: "'JetBrains Mono','Fira Code',monospace",
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
    }}>
      <div>{icon} {title}</div>
      <div style={{ textAlign: 'right', color: '#90caf9' }}>FRONTEND</div>
      <div style={{ textAlign: 'right', color: '#ce93d8' }}>BACKEND</div>
      <div style={{ textAlign: 'center', color: '#a5d6a7' }}>DIFF</div>
    </div>
  );
}

// ============================================================================
// MealCalcComparisonPanel
// ============================================================================
function MealCalcComparisonPanel({
  insulinBreakdown,
  suggestedInsulin,
  activeEffects,
  adjustedBaselineForProjection,
  patientConstants,
  lastCalculationInputs,
  selectedFoods,
  show,
  status,
  beData,
  backendMealCalc,
  frontendSnapshot,
  errorMsg,
  lastFetched,
  onToggle,
  onRefresh,
}) {
  // After form reset, insulinBreakdown/suggestedInsulin are cleared.
  // Fall back to the frozen snapshot captured just before the reset so the
  // FRONTEND column stays populated while the comparison panel is visible.
  const activeIb     = insulinBreakdown  ?? frontendSnapshot?.insulinBreakdown  ?? null;
  const activeSugg   = suggestedInsulin  || frontendSnapshot?.suggestedInsulin  || null;
  const activeInputs = lastCalculationInputs ?? frontendSnapshot?.lastCalculationInputs ?? null;

  const ib         = activeIb || {};
  const corrFactor = patientConstants?.correction_factor  ?? 50;
  const carbToBg   = patientConstants?.carb_to_bg_factor  ?? 4.0;
  const targetBG   = patientConstants?.target_glucose     ?? 100;
  const icrRatio   = patientConstants?.insulin_to_carb_ratio ?? 10;

  // ── Frontend live values ─────────────────────────────────────────────────
  const fe = {
    carbsActual:        ib.carbsActual        ?? null,
    proteinCarbEquiv:   ib.proteinCarbEquiv   ?? null,
    fatCarbEquiv:       ib.fatCarbEquiv       ?? null,
    totalCarbEquiv:     ib.totalCarbEquiv     ?? null,
    baseInsulin:        ib.baseInsulin        ?? null,
    absorptionFactor:   ib.absorptionFactor   ?? null,
    mealTimingFactor:   ib.mealTimingFactor   ?? null,
    activityImpact:     ib.activityImpact     ?? activeInputs?.activityImpact ?? null,
    adjustedInsulin:    ib.adjustedInsulin    ?? null,
    correctionInsulin:  ib.correctionInsulin  ?? null,
    bloodSugarUsed:     ib.bloodSugarUsed     ?? activeInputs?.bloodSugarUsed ?? null,
    activeInsulin:      ib.activeInsulin      ?? activeInputs?.activeInsulin  ?? null,
    activeMealCarbs:    ib.activeMealCarbs    ?? activeInputs?.activeMealCarbs ?? null,
    mobInsulinEquiv:    ib.mobInsulinEquivalent ?? null,
    postActiveTotal:    ib.postActiveTotal    ?? null,
    healthMultiplier:   ib.healthMultiplier   ?? activeInputs?.healthMultiplier ?? null,
    finalDose:          parseFloat(activeSugg) || null,
    totalIOB:           activeEffects?.iob?.total_active_insulin ?? null,
    // ✅ FIX 2: Use snapshot captured at calc time — after submit the backend
    // includes the new meal in MOB making live context stale by comparison.
    totalMOB:           activeInputs?.activeMealCarbs ?? activeEffects?.mob?.total_active_carbs ?? null,
    pendingBGRise:      activeInputs?.pendingMealRise ?? adjustedBaselineForProjection?.pendingMealRise ?? null,
    pendingBGReduction: adjustedBaselineForProjection?.pendingInsulinReduction ?? null,
    currentEstimatedBG: adjustedBaselineForProjection?.currentEstimatedBG ?? null,
    cumulativeMealEffect:    activeEffects?.netEffect?.cumulativeMealEffect    ?? null,
    cumulativeInsulinEffect: activeEffects?.netEffect?.cumulativeInsulinEffect ?? null,
    cumulativeNetBaseline:   activeEffects?.netEffect?.cumulativeNetBaseline   ?? null,
  };

  // ── Backend values ────────────────────────────────────────────────────────
  // bkd: prefer the saved meal's calculation (POST response) over the
  // active-effects-full snapshot, which does not include meal-specific
  // nutrition / dose fields.
  const bkd  = backendMealCalc?.breakdown ?? beData?.insulinCalculation?.breakdown ?? {};
  const bkIob = beData?.iob  ?? {};
  const bkMob = beData?.mob  ?? {};
  const bkBg  = beData?.bg_estimates ?? {};
  const bkCum = beData?.cumulative   ?? {};

  const be = {
    carbsActual:        bkd.carbs               ?? null,
    proteinCarbEquiv:   bkd.protein_carb_equiv  ?? null,
    fatCarbEquiv:       bkd.fat_carb_equiv      ?? null,
    totalCarbEquiv:     bkd.total_carb_equiv    ?? null,
    baseInsulin:        bkd.base_insulin        ?? null,
    absorptionFactor:   bkd.absorption_factor   ?? null,
    mealTimingFactor:   bkd.meal_timing_factor  ?? null,
    activityImpact:     bkd.activity_coefficient ?? null,
    adjustedInsulin:    bkd.adjusted_insulin    ?? null,
    correctionInsulin:  bkd.correction_insulin  ?? null,
    bloodSugarUsed:     bkd.blood_sugar_used    ?? null,
    activeInsulin:      bkd.active_insulin      ?? null,
    activeMealCarbs:    bkd.active_meal_carbs   ?? null,
    mobInsulinEquiv:    bkd.mob_insulin_equivalent ?? null,
    postActiveTotal:    bkd.post_active_total   ?? null,
    healthMultiplier:   bkd.health_multiplier   ?? null,
    finalDose:          backendMealCalc?.total ?? beData?.insulinCalculation?.total ?? null,
    totalIOB:           bkIob.total_active_insulin ?? null,
    totalMOB:           bkMob.total_active_carbs   ?? null,
    pendingBGRise:      bkBg.pending_mob_rise ?? (bkMob.total_active_carbs != null ? bkMob.total_active_carbs * carbToBg : null),
    pendingBGReduction: bkIob.total_active_insulin != null ? bkIob.total_active_insulin * corrFactor : null,
    currentEstimatedBG: bkBg.current_estimated_bg ?? null,
    cumulativeMealEffect:    bkCum.cumulative_meal_effect    ?? beData?.cumulative_meal_effect    ?? null,
    cumulativeInsulinEffect: bkCum.cumulative_insulin_effect ?? beData?.cumulative_insulin_effect ?? null,
    cumulativeNetBaseline:   bkCum.cumulative_net_baseline   ?? beData?.cumulative_net_baseline   ?? null,
  };

  // ── Alignment score ───────────────────────────────────────────────────────
  const scorePairs = [
    [fe.totalCarbEquiv,      be.totalCarbEquiv],
    [fe.baseInsulin,         be.baseInsulin],
    [fe.adjustedInsulin,     be.adjustedInsulin],
    [fe.correctionInsulin,   be.correctionInsulin],
    [fe.activeInsulin,       be.activeInsulin],
    [fe.postActiveTotal,     be.postActiveTotal],
    [fe.healthMultiplier,    be.healthMultiplier],
    [fe.finalDose,           be.finalDose],
    [fe.totalIOB,            be.totalIOB],
    [fe.totalMOB,            be.totalMOB],
    [fe.currentEstimatedBG,  be.currentEstimatedBG],
    [fe.cumulativeNetBaseline, be.cumulativeNetBaseline],
  ].filter(([a, b]) => a != null && b != null);

  const counts = scorePairs.reduce((acc, [a, b]) => {
    const d = Math.abs(a - b);
    if (d <= MEAL_CALC_DIFF.EXACT)      acc.exact++;
    else if (d <= MEAL_CALC_DIFF.CLOSE) acc.close++;
    else                                 acc.divergent++;
    return acc;
  }, { exact: 0, close: 0, divergent: 0 });

  const total = scorePairs.length;
  const score = total > 0 ? Math.round(((counts.exact + counts.close * 0.5) / total) * 100) : null;
  const scoreColor = score == null ? '#90a4ae'
    : score >= 85 ? '#2e7d32' : score >= 60 ? '#e65100' : '#c62828';

  return (
    <div style={{
      marginTop: '24px',
      border: '2px solid #37474f',
      borderRadius: '8px',
      overflow: 'hidden',
      fontFamily: "'JetBrains Mono','Fira Code',monospace",
    }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        background: 'linear-gradient(135deg,#1a237e 0%,#283593 100%)',
        color: '#e8eaf6',
        flexWrap: 'wrap',
        gap: '8px',
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '13px', letterSpacing: '0.05em' }}>
            🔬 INSULIN DOSE: FRONTEND ↔ BACKEND COMPARISON
          </div>
          <div style={{ fontSize: '10px', color: '#9fa8da', marginTop: '3px' }}>
            Validates dose calculation alignment · /api/active-effects-full
            {backendMealCalc && (
              <span style={{ marginLeft: '8px', color: '#80cbc4' }}>
                · 💾 Nutrition/dose from last saved meal
              </span>
            )}
            {!insulinBreakdown && frontendSnapshot && (
              <span style={{ marginLeft: '8px', color: '#ffcc80' }}>
                · 📸 Frontend values frozen at submit time
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {lastFetched && (
            <span style={{ fontSize: '10px', color: '#9fa8da' }}>
              Last: {lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {show && (
            <button
              onClick={onRefresh}
              disabled={status === 'loading'}
              style={{
                padding: '5px 12px', backgroundColor: status === 'loading' ? '#455a64' : '#26c6da',
                color: '#fff', border: 'none', borderRadius: '4px',
                cursor: status === 'loading' ? 'not-allowed' : 'pointer',
                fontSize: '11px', fontWeight: 700,
              }}
            >
              {status === 'loading' ? '⏳ FETCHING...' : '↻ REFRESH'}
            </button>
          )}
          <button
            onClick={onToggle}
            style={{
              padding: '5px 14px', backgroundColor: show ? '#455a64' : '#00acc1',
              color: '#fff', border: 'none', borderRadius: '4px',
              cursor: 'pointer', fontSize: '11px', fontWeight: 700,
            }}
          >
            {show ? '▲ HIDE' : '▼ COMPARE BACKEND'}
          </button>
        </div>
      </div>

      {/* ── Collapsed hint ── */}
      {!show && (
        <div style={{ padding: '10px 16px', backgroundColor: '#fafafa', fontSize: '11px', color: '#78909c', fontFamily: 'inherit' }}>
          Click <strong>▼ COMPARE BACKEND</strong> to validate the frontend insulin calculation against the backend.
          {!insulinBreakdown && <span style={{ color: '#ef6c00', marginLeft: '8px' }}>⚠️ Add foods first to generate a calculation.</span>}
        </div>
      )}

      {show && (
        <>
          {/* ── Legend ── */}
          <div style={{
            display: 'flex', gap: '20px', padding: '6px 14px',
            backgroundColor: '#eceff1', fontSize: '10px', fontWeight: 600,
            color: '#546e7a', flexWrap: 'wrap', borderBottom: '1px solid #cfd8dc',
          }}>
            <span>✅ Exact (Δ≤1.0)</span>
            <span>🟡 Close (Δ≤5.0)</span>
            <span>🔴 Divergent (Δ&gt;5.0)</span>
            <span style={{ marginLeft: 'auto', color: '#1565c0' }}>BLUE = Frontend</span>
            <span style={{ color: '#6a1b9a' }}>PURPLE = Backend</span>
          </div>

          {/* ── Data timestamps ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0',
            borderBottom: '2px solid #cfd8dc',
            fontFamily: "'JetBrains Mono','Fira Code',monospace",
            fontSize: '10px',
          }}>
            {/* Frontend timestamp */}
            <div style={{
              padding: '7px 14px',
              backgroundColor: '#e3f2fd',
              borderRight: '1px solid #cfd8dc',
            }}>
              <div style={{ color: '#1565c0', fontWeight: 700, marginBottom: '2px', letterSpacing: '0.05em' }}>
                🔵 FRONTEND DATA
              </div>
              <div style={{ color: '#1976d2' }}>
                {activeInputs?.calculatedAt
                  ? (() => {
                      const d = new Date(activeInputs.calculatedAt);
                      return `${d.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' })}  ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
                    })()
                  : <span style={{ color: '#90a4ae' }}>— not yet calculated —</span>
                }
              </div>
              {activeInputs?.calculatedAt && (
                <div style={{ color: '#90a4ae', fontSize: '9px', marginTop: '2px' }}>
                  {!insulinBreakdown && frontendSnapshot ? '📸 frozen at submit' : '⚡ live calculation'}
                </div>
              )}
            </div>

            {/* Backend timestamp */}
            <div style={{
              padding: '7px 14px',
              backgroundColor: '#f3e5f5',
            }}>
              <div style={{ color: '#6a1b9a', fontWeight: 700, marginBottom: '2px', letterSpacing: '0.05em' }}>
                🟣 BACKEND DATA
              </div>
              <div style={{ color: '#7b1fa2' }}>
                {lastFetched
                  ? `${lastFetched.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' })}  ${lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                  : <span style={{ color: '#90a4ae' }}>— not yet fetched —</span>
                }
              </div>
              {lastFetched && (
                <div style={{ color: '#90a4ae', fontSize: '9px', marginTop: '2px' }}>
                  {backendMealCalc ? '💾 meal calc + active effects' : '📡 active effects only'}
                </div>
              )}
            </div>
          </div>

          {/* ── Loading / Error / Idle states ── */}
          {status === 'idle' && (
            <div style={{ padding: '18px', textAlign: 'center', color: '#90a4ae', fontSize: '11px', fontFamily: 'inherit' }}>
              Click <strong>↻ REFRESH</strong> to load backend data.
            </div>
          )}
          {status === 'loading' && (
            <div style={{ padding: '18px', textAlign: 'center', color: '#78909c', fontSize: '11px', fontFamily: 'inherit' }}>
              ⏳ Fetching from backend…
            </div>
          )}
          {status === 'error' && (
            <div style={{ padding: '14px 16px', backgroundColor: '#ffebee', color: '#c62828', fontSize: '11px', fontFamily: 'inherit' }}>
              ⚠️ Backend fetch failed: {errorMsg}
              <div style={{ marginTop: '4px', fontSize: '10px', color: '#888' }}>
                Ensure Flask is running and /api/active-effects-full is registered.
              </div>
            </div>
          )}

          {(status === 'success' || status === 'idle') && (
            <div style={{ overflowX: 'auto' }}>

              {/* ── 1. Nutrition ── */}
              <McSection icon="🥦" title="Nutrition (Carb Equivalents)" />
              <McRow label="Actual Carbs"          sublabel="Direct carbohydrates (g)"               feVal={fe.carbsActual}       beVal={be.carbsActual}       unit="g"      precision={1} />
              <McRow label="Protein Carb Equiv"    sublabel="Protein × protein_factor"               feVal={fe.proteinCarbEquiv}  beVal={be.proteinCarbEquiv}  unit="g"      precision={2} />
              <McRow label="Fat Carb Equiv"        sublabel="Fat × fat_factor"                       feVal={fe.fatCarbEquiv}      beVal={be.fatCarbEquiv}      unit="g"      precision={2} />
              <McRow label="Total Carb Equiv"      sublabel="Carbs + protein equiv + fat equiv"      feVal={fe.totalCarbEquiv}    beVal={be.totalCarbEquiv}    unit="g"      precision={2} />

              {/* ── 2. Base Dose ── */}
              <McSection icon="💡" title="Base Insulin Dose" />
              <McRow label="Base Insulin"          sublabel={`Total carb equiv ÷ ${icrRatio} (ICR)`} feVal={fe.baseInsulin}       beVal={be.baseInsulin}       unit="u"      precision={2} />

              {/* ── 3. Adjustment Factors ── */}
              <McSection icon="⚙️" title="Adjustment Factors" />
              <McRow label="Absorption Factor"     sublabel="Food absorption type modifier"          feVal={fe.absorptionFactor}  beVal={be.absorptionFactor}  unit="×"      precision={2} />
              <McRow label="Meal Timing Factor"    sublabel="Time-of-day + meal type"                feVal={fe.mealTimingFactor}  beVal={be.mealTimingFactor}  unit="×"      precision={2} />
              <McRow label="Activity Coefficient"  sublabel="Recorded activity impact"              feVal={fe.activityImpact}    beVal={be.activityImpact}    unit="×"      precision={2} />
              <McRow label="Adjusted Insulin"      sublabel="Base × absorption × timing × activity" feVal={fe.adjustedInsulin}   beVal={be.adjustedInsulin}   unit="u"      precision={2} />

              {/* ── 4. Correction ── */}
              <McSection icon="🩺" title="Correction Insulin" />
              <McRow label="Blood Sugar Used"      sublabel="BG value used for correction"          feVal={fe.bloodSugarUsed}    beVal={be.bloodSugarUsed}    unit=" mg/dL" precision={0} />
              <McRow label="Correction Insulin"    sublabel="(BG − target) ÷ correction_factor"    feVal={fe.correctionInsulin} beVal={be.correctionInsulin} unit="u"      precision={2} />

              {/* ── 5. Active Effects ── */}
              <McSection icon="⏳" title="Active Effects (IOB / MOB)" />
              <McRow label="Total IOB"             sublabel="Insulin on board (units)"              feVal={fe.totalIOB}           beVal={be.totalIOB}           unit="u"      precision={3} />
              <McRow label="Active Insulin (IOB)"  sublabel="IOB applied as dose reduction"         feVal={fe.activeInsulin}     beVal={be.activeInsulin}     unit="u"      precision={2} />
              <McRow label="Total MOB (carbs)"     sublabel="Meal on board (grams still digesting)" feVal={fe.totalMOB}           beVal={be.totalMOB}           unit="g"      precision={1} />
              <McRow label="MOB Insulin Equiv"     sublabel="MOB ÷ ICR (added back to dose)"       feVal={fe.mobInsulinEquiv}   beVal={be.mobInsulinEquiv}   unit="u"      precision={2} />
              <McRow label="Post-Active Total"     sublabel="adjusted − IOB + MOB equiv"           feVal={fe.postActiveTotal}   beVal={be.postActiveTotal}   unit="u"      precision={2} />

              {/* ── 6. Health ── */}
              <McSection icon="🏥" title="Health Multiplier" />
              <McRow label="Health Multiplier"     sublabel="Conditions + medications factor"       feVal={fe.healthMultiplier}  beVal={be.healthMultiplier}  unit="×"      precision={3} />

              {/* ── 7. Final Dose ── */}
              <McSection icon="💉" title="Final Insulin Dose" />
              <McRow label="Final Dose"            sublabel="post_active_total × health_multiplier" feVal={fe.finalDose}         beVal={be.finalDose}         unit="u"      precision={1} />

              {/* ── 8. BG Context ── */}
              <McSection icon="🩸" title="BG Context (Active Effects)" />
              <McRow label="Current Est. BG"       sublabel="Estimated BG right now"                feVal={fe.currentEstimatedBG}  beVal={be.currentEstimatedBG}  unit=" mg/dL" precision={0} />
              <McRow label="Pending BG Rise"       sublabel="Expected future rise from MOB"         feVal={fe.pendingBGRise}       beVal={be.pendingBGRise}       unit=" mg/dL" precision={1} />
              <McRow label="Pending BG Reduction"  sublabel="Expected future drop from IOB"         feVal={fe.pendingBGReduction}  beVal={be.pendingBGReduction}  unit=" mg/dL" precision={1} />

              {/* ── 9. Cumulative Baseline ── */}
              <McSection icon="📊" title="Cumulative Daily Baseline" />
              <McRow label="Cumulative Meal Effect"     sublabel="Total BG elevation from absorbed carbs today" feVal={fe.cumulativeMealEffect}    beVal={be.cumulativeMealEffect}    unit=" mg/dL" precision={1} />
              <McRow label="Cumulative Insulin Effect"  sublabel="Total BG reduction from absorbed insulin today" feVal={fe.cumulativeInsulinEffect} beVal={be.cumulativeInsulinEffect} unit=" mg/dL" precision={1} />
              <McRow label="Cumulative Net Baseline"    sublabel="Net daily shift (meal + insulin effects)"      feVal={fe.cumulativeNetBaseline}   beVal={be.cumulativeNetBaseline}   unit=" mg/dL" precision={1} />

            </div>
          )}

          {/* ── Score bar ── */}
          {status === 'success' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '16px',
              padding: '12px 16px', backgroundColor: '#eceff1',
              borderTop: '2px solid #cfd8dc',
              fontFamily: "'JetBrains Mono',monospace", fontSize: '11px', flexWrap: 'wrap',
            }}>
              <div style={{ fontWeight: 700, color: '#455a64', letterSpacing: '0.05em' }}>ALIGNMENT SCORE</div>
              <div style={{ fontSize: '24px', fontWeight: 900, color: scoreColor, lineHeight: 1 }}>
                {score != null ? `${score}%` : 'N/A'}
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <span style={{ color: '#2e7d32' }}>✅ {counts.exact} exact</span>
                <span style={{ color: '#e65100' }}>🟡 {counts.close} close</span>
                <span style={{ color: '#c62828' }}>🔴 {counts.divergent} divergent</span>
                <span style={{ color: '#78909c' }}>/ {total} compared</span>
              </div>
              {score != null && score < 85 && (
                <div style={{ color: '#b71c1c', fontWeight: 600, fontSize: '10px', flex: '1 0 100%', marginTop: '4px' }}>
                  ⚠️ Divergent values detected. Check pharmacodynamics constants and IOB/MOB field mapping.
                </div>
              )}
              {score != null && score >= 85 && (
                <div style={{ color: '#1b5e20', fontWeight: 600, fontSize: '10px', flex: '1 0 100%', marginTop: '4px' }}>
                  ✅ Frontend and backend insulin calculations are well-aligned.
                </div>
              )}
            </div>
          )}

          {/* ── Raw JSON (collapsible) ── */}
          {status === 'success' && beData && (
            <details style={{ padding: '0 12px 12px', backgroundColor: '#fafafa' }}>
              <summary style={{ padding: '10px 0', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#546e7a', fontFamily: 'inherit', letterSpacing: '0.04em' }}>
                📋 RAW BACKEND RESPONSE (click to expand)
              </summary>
              <pre style={{
                margin: '8px 0 0', padding: '12px', backgroundColor: '#1e2a35',
                color: '#a8d8a8', fontSize: '10px', borderRadius: '4px',
                overflowX: 'auto', lineHeight: '1.5', whiteSpace: 'pre-wrap',
                wordBreak: 'break-word', fontFamily: "'JetBrains Mono','Fira Code',monospace",
              }}>
                {JSON.stringify(beData, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

export default MealInput;





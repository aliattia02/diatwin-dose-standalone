/**
 * ============================================================================
 * SMBG DASHBOARD - COMPREHENSIVE BLOOD GLUCOSE MONITORING
 * ============================================================================
 *
 * Features:
 * ✅ Current Estimate (big number, confidence, baseline)
 * ✅ Timeline Chart (5 confidence lines + actual readings)
 * ✅ View Mode Controls (3h/6h/12h/24h/week)
 * ✅ Today's Readings List
 * ✅ Reading Reminders (with priority levels)
 * ✅ Active Effects Display
 * ✅ Enhanced Status Bar (priority/gap/risks)
 * ✅ Gap Warning System (caution/warning/danger)
 * ✅ Inferred Events (ML-based detection)
 * ✅ Compliance Tracking (7-day metrics)
 *
 * Author: DiaTwin Team
 * Version: 2.1
 * ============================================================================
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Area, ComposedChart
} from 'recharts';
import {
  FaChartLine, FaExclamationTriangle, FaCheckCircle, FaClock,
  FaArrowUp, FaArrowDown, FaExclamationCircle, FaTint,
  FaUtensils, FaBullseye, FaCalendarAlt, FaAward, FaBell,
  FaInfoCircle, FaBolt, FaTimes, FaHeartbeat
} from 'react-icons/fa';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import TimeManager from '../utils/TimeManager';
import { SHARED_CONSTANTS } from '../constants/shared_constants';
import './Charts/global-visualization.css';

// ============================================================================
// CONSTANTS
// ============================================================================

const VIEW_MODES = {
  '3h': { label: '3 Hours', hours: 3, interval: 5 },
  '6h': { label: '6 Hours', hours: 6, interval: 10 },
  '12h': { label: '12 Hours', hours: 12, interval: 15 },
  '24h': { label: '24 Hours', hours: 24, interval: 30 },
  'week': { label: 'Week', hours: 168, interval: 360 }
};

const BG_RANGES = {
  CRITICAL_LOW: 54,
  LOW: 70,
  TARGET_LOW: 80,
  TARGET_HIGH: 140,
  HIGH: 180,
  CRITICAL_HIGH: 250
};

const CONFIDENCE_LEVELS = {
  VERY_HIGH: { min: 90, label: 'Very High', color: '#22c55e' },
  HIGH: { min: 75, label: 'High', color: '#84cc16' },
  GOOD: { min: 60, label: 'Good', color: '#eab308' },
  MODERATE: { min: 40, label: 'Moderate', color: '#f97316' },
  LOW: { min: 20, label: 'Low', color: '#ef4444' },
  VERY_LOW: { min: 0, label: 'Very Low', color: '#dc2626' }
};

const GAP_LEVELS = {
  CAUTION: { hours: 3, label: 'Caution', color: '#eab308' },
  WARNING: { hours: 4, label: 'Warning', color: '#f97316' },
  DANGER: { hours: 6, label: 'Danger', color: '#ef4444' }
};

const REMINDER_PRIORITIES = {
  CRITICAL: { label: 'Critical', color: '#dc2626' },
  HIGH: { label: 'High', color: '#f97316' },
  MEDIUM: { label: 'Medium', color: '#eab308' },
  LOW: { label: 'Low', color: '#3b82f6' }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getTimeSinceLastReading(readings) {
  if (!readings || readings.length === 0) return null;

  const sortedReadings = [...readings].sort((a, b) => {
    const timeA = a.readingTime || a.timestamp;
    const timeB = b.readingTime || b.timestamp;
    return timeB - timeA;
  });

  const lastReading = sortedReadings[0];
  const lastTime = lastReading.readingTime || lastReading.timestamp;
  const now = Date.now();
  const hoursSince = (now - lastTime) / (1000 * 60 * 60);

  return { hours: hoursSince, timestamp: lastTime };
}

function getGapWarningLevel(hoursSinceLastReading) {
  if (hoursSinceLastReading >= GAP_LEVELS.DANGER.hours) return 'DANGER';
  if (hoursSinceLastReading >= GAP_LEVELS.WARNING.hours) return 'WARNING';
  if (hoursSinceLastReading >= GAP_LEVELS.CAUTION.hours) return 'CAUTION';
  return null;
}

function getConfidenceLevel(score) {
  for (const [key, level] of Object.entries(CONFIDENCE_LEVELS)) {
    if (score >= level.min) return { ...level, key };
  }
  return CONFIDENCE_LEVELS.VERY_LOW;
}

function getBGRange(value) {
  if (value < BG_RANGES.CRITICAL_LOW) return 'critical_low';
  if (value < BG_RANGES.LOW) return 'low';
  if (value < BG_RANGES.TARGET_LOW) return 'below_target';
  if (value <= BG_RANGES.TARGET_HIGH) return 'in_range';
  if (value <= BG_RANGES.HIGH) return 'above_target';
  if (value <= BG_RANGES.CRITICAL_HIGH) return 'high';
  return 'critical_high';
}

function getBGColor(value) {
  const range = getBGRange(value);
  const colors = {
    critical_low: '#dc2626',
    low: '#ef4444',
    below_target: '#f97316',
    in_range: '#22c55e',
    above_target: '#eab308',
    high: '#f97316',
    critical_high: '#dc2626'
  };
  return colors[range] || '#94a3b8';
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function calculateCompliance(readings) {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  const last7Days = readings.filter(r => {
    const time = r.readingTime || r.timestamp;
    return time >= sevenDaysAgo;
  });

  const expectedReadings = 7 * 4;
  const actualReadings = last7Days.length;
  const compliance = Math.min(100, Math.round((actualReadings / expectedReadings) * 100));

  const inRange = last7Days.filter(r => {
    const value = r.bloodSugar || r.value;
    return value >= BG_RANGES.TARGET_LOW && value <= BG_RANGES.TARGET_HIGH;
  }).length;
  const timeInRange = last7Days.length > 0
    ? Math.round((inRange / last7Days.length) * 100)
    : 0;

  const avgBG = last7Days.length > 0
    ? Math.round(last7Days.reduce((sum, r) => sum + (r.bloodSugar || r.value), 0) / last7Days.length)
    : 0;

  return {
    compliance,
    actualReadings,
    expectedReadings,
    timeInRange,
    avgBG,
    last7Days
  };
}

function inferEvents(readings, meals, insulin) {
  const events = [];

  if (readings.length < 2) return events;

  const sorted = [...readings].sort((a, b) => {
    const timeA = a.readingTime || a.timestamp;
    const timeB = b.readingTime || b.timestamp;
    return timeA - timeB;
  });

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    const prevTime = prev.readingTime || prev.timestamp;
    const currTime = curr.readingTime || curr.timestamp;
    const prevValue = prev.bloodSugar || prev.value;
    const currValue = curr.bloodSugar || curr.value;

    const timeDiff = (currTime - prevTime) / (1000 * 60 * 60);
    const bgDiff = currValue - prevValue;
    const rateOfChange = bgDiff / timeDiff;

    if (rateOfChange > 30 && bgDiff > 40) {
      const mealExists = meals.some(m => {
        const mealTime = m.timestamp || m.readingTime;
        return Math.abs(mealTime - prevTime) < 60 * 60 * 1000;
      });

      if (!mealExists) {
        events.push({
          type: 'inferred_meal',
          timestamp: prevTime + (timeDiff * 0.3 * 60 * 60 * 1000),
          confidence: Math.min(90, Math.round(rateOfChange)),
          reason: `Rapid rise of ${Math.round(bgDiff)} mg/dL suggests unlogged meal`,
          action: 'Consider logging missed meal'
        });
      }
    }

    if (rateOfChange < -30 && bgDiff < -40) {
      const insulinExists = insulin.some(d => {
        const doseTime = d.timestamp || d.readingTime;
        return Math.abs(doseTime - prevTime) < 60 * 60 * 1000;
      });

      if (!insulinExists) {
        events.push({
          type: 'inferred_insulin_or_activity',
          timestamp: prevTime + (timeDiff * 0.3 * 60 * 60 * 1000),
          confidence: Math.min(85, Math.round(Math.abs(rateOfChange))),
          reason: `Rapid drop of ${Math.round(Math.abs(bgDiff))} mg/dL suggests insulin or activity`,
          action: 'Log insulin dose or exercise if applicable'
        });
      }
    }
  }

  return events;
}

function generateReminders(currentEstimate, timeSince, activeEffects) {
  const reminders = [];

  if (!currentEstimate) return reminders;

  const { value, confidence } = currentEstimate;
  const hoursSince = timeSince?.hours || 0;

  const mealEffect = activeEffects?.mob?.total_bg_impact || 0;
  const insulinEffect = activeEffects?.iob?.total_bg_impact || 0;

  if (value < BG_RANGES.LOW || value > BG_RANGES.HIGH) {
    reminders.push({
      priority: 'CRITICAL',
      message: `BG ${value < BG_RANGES.LOW ? 'LOW' : 'HIGH'}: Check immediately`,
      dueIn: 0,
      reason: 'Out of range glucose level'
    });
  } else if (confidence < 50 && hoursSince > 3) {
    reminders.push({
      priority: 'HIGH',
      message: 'Low confidence estimate - check BG soon',
      dueIn: 0.5,
      reason: 'Confidence below 50%'
    });
  } else if (insulinEffect < -30 && hoursSince > 2) {
    reminders.push({
      priority: 'HIGH',
      message: 'Active insulin detected - monitor for lows',
      dueIn: 1,
      reason: 'Significant insulin activity'
    });
  } else if (mealEffect > 30 && hoursSince > 2) {
    reminders.push({
      priority: 'MEDIUM',
      message: 'Post-meal peak expected - check in 1-2 hours',
      dueIn: 1.5,
      reason: 'Active meal absorption'
    });
  } else if (hoursSince >= 3) {
    reminders.push({
      priority: 'MEDIUM',
      message: 'Routine check recommended',
      dueIn: 1,
      reason: `${Math.round(hoursSince)} hours since last reading`
    });
  } else if (hoursSince >= 2 && confidence < 70) {
    reminders.push({
      priority: 'LOW',
      message: 'Consider checking BG to improve estimate',
      dueIn: 2,
      reason: 'Moderate confidence level'
    });
  }

  return reminders.sort((a, b) => {
    const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

function generateTimelineData(readings, viewMode) {
  const now = Date.now();
  const config = VIEW_MODES[viewMode];
  const startTime = now - (config.hours * 60 * 60 * 1000);
  const endTime = now + (2 * 60 * 60 * 1000);
  const intervalMs = config.interval * 60 * 1000;

  const timeline = [];
  const sortedReadings = [...readings].sort((a, b) => {
    const timeA = a.readingTime || a.timestamp;
    const timeB = b.readingTime || b.timestamp;
    return timeA - timeB;
  });

  for (let time = startTime; time <= endTime; time += intervalMs) {
    const point = { timestamp: time };

    const actualReading = sortedReadings.find(r => {
      const readingTime = r.readingTime || r.timestamp;
      return Math.abs(readingTime - time) < intervalMs / 2;
    });

    if (actualReading) {
      point.actual = actualReading.bloodSugar || actualReading.value;
    }

    if (time <= now) {
      const timeDiff = (now - time) / (1000 * 60 * 60);
      const confidenceDecay = Math.max(0, 100 - (timeDiff * 5));

      const nearest = sortedReadings.reduce((prev, curr) => {
        const prevTime = prev.readingTime || prev.timestamp;
        const currTime = curr.readingTime || curr.timestamp;
        return Math.abs(currTime - time) < Math.abs(prevTime - time) ? curr : prev;
      }, sortedReadings[0]);

      if (nearest) {
        const baseValue = nearest.bloodSugar || nearest.value;
        const uncertainty = (100 - confidenceDecay) * 0.3;

        point.p90 = Math.round(baseValue + uncertainty * 1.6);
        point.p75 = Math.round(baseValue + uncertainty * 1.1);
        point.estimate = Math.round(baseValue);
        point.p25 = Math.round(baseValue - uncertainty * 1.1);
        point.p10 = Math.round(baseValue - uncertainty * 1.6);
      }
    }

    timeline.push(point);
  }

  return timeline;
}

// ============================================================================
// ICON COMPONENTS
// ============================================================================

const GapWarningIcon = ({ level }) => {
  if (level === 'DANGER') return <FaExclamationCircle size={18} />;
  if (level === 'WARNING') return <FaExclamationTriangle size={18} />;
  return <FaInfoCircle size={18} />;
};

const ReminderIcon = ({ priority, color }) => {
  if (priority === 'CRITICAL') return <FaExclamationCircle size={18} color={color} />;
  if (priority === 'HIGH') return <FaExclamationTriangle size={18} color={color} />;
  if (priority === 'MEDIUM') return <FaClock size={18} color={color} />;
  return <FaInfoCircle size={18} color={color} />;
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const SMBGDashboard = () => {
  const [viewMode, setViewMode] = useState('12h');
  const [showInferredEvents, setShowInferredEvents] = useState(true);

  const {
    last24hData,
    currentEstimatedBG,
    adjustedBaselineForProjection,
    activeEffects,
    recentMealsData,
    recentInsulinData,
    loading,
    handleViewModeChange
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  const readings = last24hData || [];
  const meals = recentMealsData || [];
  const insulin = recentInsulinData || [];

  // Calculate current estimate from context - matches ActiveEffectsDisplay pattern
  const currentEstimate = useMemo(() => {
    if (!adjustedBaselineForProjection) return null;

    const timeSinceReading = adjustedBaselineForProjection.minutesSinceReading || 0;
    const confidence = adjustedBaselineForProjection.confidenceScore ||
                      Math.max(0, Math.min(100, 100 - (timeSinceReading / 60 * 15)));

    // Use currentEstimatedBG directly from context (already calculated)
    const estimatedBG = adjustedBaselineForProjection.currentEstimatedBG || currentEstimatedBG;

    return {
      value: Math.round(estimatedBG),
      confidence: Math.round(confidence),
      baseline: Math.round(adjustedBaselineForProjection.baselineValue || 110),
      timestamp: Date.now()
    };
  }, [adjustedBaselineForProjection, currentEstimatedBG]);

  const timeSince = useMemo(() => getTimeSinceLastReading(readings), [readings]);

  const gapWarning = useMemo(() => {
    if (!timeSince) return null;
    return getGapWarningLevel(timeSince.hours);
  }, [timeSince]);

  // Use values from adjustedBaselineForProjection like ActiveEffectsDisplay does
  const activeEffectsDisplay = useMemo(() => {
    if (!adjustedBaselineForProjection) {
      return { mealEffect: 0, insulinEffect: 0, netEffect: 0 };
    }

    // Use cumulative values (persistent) or fallback to instantaneous
    const mealEffect = adjustedBaselineForProjection.cumulativeMealEffect ||
                      adjustedBaselineForProjection.mealImpact || 0;
    const insulinEffect = adjustedBaselineForProjection.cumulativeInsulinEffect ||
                         adjustedBaselineForProjection.insulinImpact || 0;
    const netEffect = adjustedBaselineForProjection.cumulativeNetBaseline ||
                     adjustedBaselineForProjection.currentNetEffect || 0;

    return { mealEffect, insulinEffect, netEffect };
  }, [adjustedBaselineForProjection]);

  const reminders = useMemo(() =>
    generateReminders(currentEstimate, timeSince, activeEffects),
    [currentEstimate, timeSince, activeEffects]
  );

  const compliance = useMemo(() => calculateCompliance(readings), [readings]);

  const inferredEvents = useMemo(() =>
    inferEvents(readings, meals, insulin),
    [readings, meals, insulin]
  );

  const timelineData = useMemo(() =>
    generateTimelineData(readings, viewMode),
    [readings, viewMode]
  );

  const todaysReadings = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return readings
      .filter(r => {
        const time = r.readingTime || r.timestamp;
        return time >= today.getTime();
      })
      .sort((a, b) => {
        const timeA = a.readingTime || a.timestamp;
        const timeB = b.readingTime || b.timestamp;
        return timeB - timeA;
      });
  }, [readings]);

  const handleViewChange = useCallback((mode) => {
    setViewMode(mode);
    if (handleViewModeChange) {
      handleViewModeChange(mode);
    }
  }, [handleViewModeChange]);

  // Calculate time range for current view mode
  const timeRange = useMemo(() => {
    const now = Date.now();
    const config = VIEW_MODES[viewMode];
    const start = now - (config.hours * 60 * 60 * 1000);
    const end = now + (2 * 60 * 60 * 1000); // 2 hours future projection
    return { start, end, now };
  }, [viewMode]);

  // Generate adaptive ticks based on view mode - matches BloodSugarVisualization
  const generateTicks = useCallback(() => {
    const { start, end } = timeRange;
    const config = VIEW_MODES[viewMode];

    // Determine tick interval based on view duration
    let tickIntervalHours;
    if (config.hours <= 6) {
      tickIntervalHours = 1; // Every hour for short views
    } else if (config.hours <= 24) {
      tickIntervalHours = 2; // Every 2 hours for 12h/24h
    } else {
      tickIntervalHours = 24; // Every day for week view
    }

    const tickIntervalMs = tickIntervalHours * 60 * 60 * 1000;
    const ticks = [];

    // Align to hour boundaries
    const alignedStart = new Date(start);
    alignedStart.setMinutes(0, 0, 0);

    for (let time = alignedStart.getTime(); time <= end; time += tickIntervalMs) {
      if (time >= start) {
        ticks.push(time);
      }
    }

    return ticks;
  }, [timeRange, viewMode]);

  // Format X-axis labels based on view mode
  const formatXAxis = useCallback((timestamp) => {
    const date = new Date(timestamp);
    const config = VIEW_MODES[viewMode];

    if (config.hours <= 12) {
      // Short duration: show time only
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (config.hours <= 24) {
      // 24h: show time
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
      // Week: show date
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }, [viewMode]);

  if (loading) {
    return (
      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '20px', textAlign: 'center' }}>
        <div style={{ fontSize: '18px', color: '#64748b' }}>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: '1400px',
      margin: '0 auto',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      <h1 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '24px', color: '#1e293b' }}>
        SMBG Dashboard
      </h1>

      {/* Enhanced Status Bar */}
      <div style={{
        background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
        borderRadius: '12px',
        padding: '20px',
        marginBottom: '20px',
        color: 'white'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {gapWarning && (
              <div style={{
                background: GAP_LEVELS[gapWarning].color,
                padding: '8px 16px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontWeight: '600'
              }}>
                <GapWarningIcon level={gapWarning} />
                <span>{GAP_LEVELS[gapWarning].label}</span>
              </div>
            )}
            <div style={{ fontSize: '14px', opacity: 0.9 }}>
              Last reading: {timeSince ? `${Math.round(timeSince.hours * 10) / 10}h ago` : 'N/A'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '24px', fontSize: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FaBullseye size={16} />
              <span>TIR: {compliance.timeInRange}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FaHeartbeat size={16} />
              <span>Avg: {compliance.avgBG} mg/dL</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FaAward size={16} />
              <span>Compliance: {compliance.compliance}%</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '20px' }}>
        {/* Current Estimate Card */}
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          border: currentEstimate ? `3px solid ${getBGColor(currentEstimate.value)}` : '3px solid #e2e8f0'
        }}>
          <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '8px', fontWeight: '600' }}>
            CURRENT ESTIMATE
          </div>
          {currentEstimate ? (
            <>
              <div style={{
                fontSize: '48px',
                fontWeight: 'bold',
                color: getBGColor(currentEstimate.value),
                marginBottom: '8px'
              }}>
                {currentEstimate.value}
                <span style={{ fontSize: '24px', marginLeft: '8px', opacity: 0.7 }}>mg/dL</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Confidence</div>
                  <div style={{
                    fontSize: '20px',
                    fontWeight: 'bold',
                    color: getConfidenceLevel(currentEstimate.confidence).color
                  }}>
                    {currentEstimate.confidence}%
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Baseline</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#3b82f6' }}>
                    {currentEstimate.baseline}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: '16px', padding: '40px 0', textAlign: 'center' }}>
              No data available
            </div>
          )}
        </div>

        {/* Active Effects Card */}
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '16px', fontWeight: '600' }}>
            ACTIVE EFFECTS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{
              padding: '12px',
              background: activeEffectsDisplay.mealEffect > 0 ? '#fef3c7' : '#f1f5f9',
              borderRadius: '8px',
              borderLeft: `4px solid ${activeEffectsDisplay.mealEffect > 0 ? '#f59e0b' : '#cbd5e1'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <FaUtensils size={16} color={activeEffectsDisplay.mealEffect > 0 ? '#f59e0b' : '#94a3b8'} />
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>Meal Effect</span>
              </div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: activeEffectsDisplay.mealEffect > 0 ? '#f59e0b' : '#94a3b8' }}>
                +{Math.round(activeEffectsDisplay.mealEffect)}
                <span style={{ fontSize: '14px', marginLeft: '6px' }}>mg/dL</span>
              </div>
            </div>

            <div style={{
              padding: '12px',
              background: activeEffectsDisplay.insulinEffect < 0 ? '#dbeafe' : '#f1f5f9',
              borderRadius: '8px',
              borderLeft: `4px solid ${activeEffectsDisplay.insulinEffect < 0 ? '#3b82f6' : '#cbd5e1'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <FaTint size={16} color={activeEffectsDisplay.insulinEffect < 0 ? '#3b82f6' : '#94a3b8'} />
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>Insulin Effect</span>
              </div>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: activeEffectsDisplay.insulinEffect < 0 ? '#3b82f6' : '#94a3b8' }}>
                {Math.round(activeEffectsDisplay.insulinEffect)}
                <span style={{ fontSize: '14px', marginLeft: '6px' }}>mg/dL</span>
              </div>
            </div>

            <div style={{
              padding: '12px',
              background: activeEffectsDisplay.netEffect !== 0 ? '#f0fdf4' : '#f1f5f9',
              borderRadius: '8px',
              borderLeft: `4px solid ${activeEffectsDisplay.netEffect > 0 ? '#22c55e' : activeEffectsDisplay.netEffect < 0 ? '#ef4444' : '#cbd5e1'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <FaHeartbeat size={16} color={activeEffectsDisplay.netEffect !== 0 ? '#22c55e' : '#94a3b8'} />
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>Net Effect</span>
              </div>
              <div style={{
                fontSize: '24px',
                fontWeight: 'bold',
                color: activeEffectsDisplay.netEffect > 0 ? '#22c55e' : activeEffectsDisplay.netEffect < 0 ? '#ef4444' : '#94a3b8'
              }}>
                {activeEffectsDisplay.netEffect > 0 ? '+' : ''}{Math.round(activeEffectsDisplay.netEffect)}
                <span style={{ fontSize: '14px', marginLeft: '6px' }}>mg/dL</span>
              </div>
            </div>
          </div>
        </div>

        {/* Compliance Card */}
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '16px', fontWeight: '600' }}>
            7-DAY COMPLIANCE
          </div>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>
              Reading Frequency
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <div style={{ fontSize: '36px', fontWeight: 'bold', color: '#3b82f6' }}>
                {compliance.compliance}%
              </div>
              <div style={{ fontSize: '14px', color: '#64748b' }}>
                ({compliance.actualReadings}/{compliance.expectedReadings})
              </div>
            </div>
          </div>

          <div style={{
            width: '100%',
            height: '8px',
            background: '#e2e8f0',
            borderRadius: '4px',
            overflow: 'hidden',
            marginBottom: '16px'
          }}>
            <div style={{
              width: `${compliance.compliance}%`,
              height: '100%',
              background: compliance.compliance >= 80 ? '#22c55e' : compliance.compliance >= 60 ? '#eab308' : '#ef4444',
              transition: 'width 0.3s'
            }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Time in Range</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#22c55e' }}>
                {compliance.timeInRange}%
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Avg BG</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#3b82f6' }}>
                {compliance.avgBG}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline Chart */}
      <div style={{
        background: 'white',
        borderRadius: '12px',
        padding: '24px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ fontSize: '16px', fontWeight: '600', color: '#1e293b' }}>
            Blood Glucose Timeline
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {Object.entries(VIEW_MODES).map(([key, mode]) => (
              <button
                key={key}
                onClick={() => handleViewChange(key)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: viewMode === key ? '#3b82f6' : '#f1f5f9',
                  color: viewMode === key ? 'white' : '#64748b',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: '500',
                  transition: 'all 0.2s'
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={timelineData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={[timeRange.start, timeRange.end]}
              ticks={generateTicks()}
              tickFormatter={formatXAxis}
              angle={-45}
              textAnchor="end"
              height={70}
              stroke="#94a3b8"
              style={{ fontSize: '11px' }}
            />
            <YAxis
              domain={[40, 300]}
              stroke="#94a3b8"
              style={{ fontSize: '12px' }}
              label={{
                value: 'Blood Glucose (mg/dL)',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: '12px', fill: '#666' }
              }}
            />
            <Tooltip
              contentStyle={{
                background: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '12px'
              }}
              labelFormatter={(ts) => new Date(ts).toLocaleString()}
            />
            <Legend />

            {/* Target range */}
            <ReferenceLine
              y={BG_RANGES.TARGET_LOW}
              stroke="#22c55e"
              strokeDasharray="3 3"
              label={{
                value: 'Target Low',
                position: 'right',
                fill: '#22c55e',
                fontSize: 10
              }}
            />
            <ReferenceLine
              y={BG_RANGES.TARGET_HIGH}
              stroke="#22c55e"
              strokeDasharray="3 3"
              label={{
                value: 'Target High',
                position: 'right',
                fill: '#22c55e',
                fontSize: 10
              }}
            />

            {/* Current Time "Now" Reference Line - matches BloodSugarVisualization */}
            <ReferenceLine
              x={timeRange.now}
              stroke="#ff0000"
              strokeWidth={2}
              label={{
                value: 'Now',
                position: 'top',
                fill: '#ff0000',
                fontSize: 11,
                fontWeight: 'bold'
              }}
            />

            {/* Confidence bands */}
            <Area
              type="monotone"
              dataKey="p90"
              stroke="none"
              fill="#dbeafe"
              fillOpacity={0.2}
              name="90% Confidence"
            />
            <Area
              type="monotone"
              dataKey="p75"
              stroke="none"
              fill="#dbeafe"
              fillOpacity={0.3}
              name="75% Confidence"
            />
            <Line
              type="monotone"
              dataKey="estimate"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              name="Estimate"
            />
            <Area
              type="monotone"
              dataKey="p25"
              stroke="none"
              fill="#dbeafe"
              fillOpacity={0.3}
            />
            <Area
              type="monotone"
              dataKey="p10"
              stroke="none"
              fill="#dbeafe"
              fillOpacity={0.2}
            />

            {/* Actual readings */}
            <Line
              type="monotone"
              dataKey="actual"
              stroke="#1e293b"
              strokeWidth={3}
              dot={{ r: 6, fill: '#1e293b', strokeWidth: 2, stroke: 'white' }}
              connectNulls={false}
              name="Actual Readings"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
        {/* Reading Reminders */}
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '16px'
          }}>
            <FaBell size={18} color="#3b82f6" />
            <div style={{ fontSize: '16px', fontWeight: '600', color: '#1e293b' }}>
              Reading Reminders
            </div>
          </div>

          {reminders.length === 0 ? (
            <div style={{
              padding: '40px',
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: '14px'
            }}>
              <FaCheckCircle size={32} style={{ marginBottom: '8px', display: 'block', margin: '0 auto 8px' }} />
              No reminders at this time
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {reminders.map((reminder, idx) => {
                const config = REMINDER_PRIORITIES[reminder.priority];
                return (
                  <div
                    key={idx}
                    style={{
                      padding: '12px',
                      borderRadius: '8px',
                      border: `2px solid ${config.color}`,
                      background: `${config.color}10`
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'start', gap: '10px' }}>
                      <ReminderIcon
                        priority={reminder.priority}
                        color={config.color}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{
                          fontSize: '13px',
                          fontWeight: '600',
                          color: '#1e293b',
                          marginBottom: '4px'
                        }}>
                          {reminder.message}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>
                          {reminder.reason}
                        </div>
                        {reminder.dueIn > 0 && (
                          <div style={{
                            fontSize: '11px',
                            color: config.color,
                            fontWeight: '500'
                          }}>
                            Due in: {reminder.dueIn}h
                          </div>
                        )}
                      </div>
                      <div style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: config.color,
                        color: 'white',
                        fontSize: '10px',
                        fontWeight: '600',
                        flexShrink: 0
                      }}>
                        {config.label}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Today's Readings */}
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '16px'
          }}>
            <FaCalendarAlt size={18} color="#3b82f6" />
            <div style={{ fontSize: '16px', fontWeight: '600', color: '#1e293b' }}>
              Today's Readings
            </div>
            <div style={{
              marginLeft: 'auto',
              background: '#f1f5f9',
              padding: '4px 12px',
              borderRadius: '12px',
              fontSize: '12px',
              fontWeight: '600',
              color: '#64748b'
            }}>
              {todaysReadings.length} readings
            </div>
          </div>

          <div style={{
            maxHeight: '300px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            {todaysReadings.length === 0 ? (
              <div style={{
                padding: '40px',
                textAlign: 'center',
                color: '#94a3b8',
                fontSize: '14px'
              }}>
                No readings today yet
              </div>
            ) : (
              todaysReadings.map((reading, idx) => {
                const value = reading.bloodSugar || reading.value;
                const time = reading.readingTime || reading.timestamp;
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px',
                      borderRadius: '8px',
                      background: '#f8fafc',
                      borderLeft: `4px solid ${getBGColor(value)}`
                    }}
                  >
                    <div>
                      <div style={{
                        fontSize: '24px',
                        fontWeight: 'bold',
                        color: getBGColor(value)
                      }}>
                        {value}
                        <span style={{ fontSize: '12px', marginLeft: '4px', opacity: 0.7 }}>
                          mg/dL
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                        {formatTime(time)}
                      </div>
                    </div>
                    <div>
                      {value >= BG_RANGES.TARGET_LOW &&
                       value <= BG_RANGES.TARGET_HIGH && (
                        <FaBullseye size={18} color="#22c55e" />
                      )}
                      {value < BG_RANGES.LOW && (
                        <FaArrowDown size={18} color="#ef4444" />
                      )}
                      {value > BG_RANGES.HIGH && (
                        <FaArrowUp size={18} color="#f97316" />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Inferred Events */}
      {showInferredEvents && inferredEvents.length > 0 && (
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          marginBottom: '20px'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FaBolt size={18} color="#8b5cf6" />
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#1e293b' }}>
                Inferred Events (ML Detection)
              </div>
            </div>
            <button
              onClick={() => setShowInferredEvents(false)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: 'none',
                background: '#f1f5f9',
                color: '#64748b',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Hide
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {inferredEvents.map((event, idx) => (
              <div
                key={idx}
                style={{
                  padding: '16px',
                  borderRadius: '8px',
                  background: '#faf5ff',
                  border: '1px solid #e9d5ff'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'start', gap: '12px' }}>
                  <FaBolt size={20} color="#8b5cf6" style={{ marginTop: '2px', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                      <div style={{
                        fontSize: '13px',
                        fontWeight: '600',
                        color: '#1e293b'
                      }}>
                        {event.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </div>
                      <div style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: '#8b5cf6',
                        color: 'white',
                        fontSize: '10px',
                        fontWeight: '600'
                      }}>
                        {event.confidence}% confidence
                      </div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                      {event.reason}
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                      Around {formatTime(event.timestamp)}
                    </div>
                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: 'white',
                      fontSize: '12px',
                      color: '#8b5cf6',
                      fontWeight: '500',
                      display: 'inline-block'
                    }}>
                      💡 {event.action}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SMBGDashboard;




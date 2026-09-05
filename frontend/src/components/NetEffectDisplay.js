import React, { useState, useEffect, useCallback } from 'react';
import { useNetEffect } from '../contexts/NetEffectContext';
import './Charts/global-visualization.css';

const NetEffectDisplay = ({ combinedData, targetGlucose = 100 }) => {
  const { updateNetEffect, lastUpdate } = useNetEffect();
  const [displayValue, setDisplayValue] = useState(null);

  const calculateCurrentProjectedEffect = useCallback(() => {
    if (!combinedData || combinedData.length === 0) return null;

    const now = Date.now();
    let closestPoint = null;
    let minDiff = Infinity;

    // Find closest point to current time
    for (const point of combinedData) {
      const diff = Math.abs(point.timestamp - now);
      if (diff < minDiff) {
        minDiff = diff;
        closestPoint = point;
      }
    }

    // Find last actual blood sugar reading
    let lastActualReading = null;
    let lastReadingTime = null;
    for (let i = combinedData.length - 1; i >= 0; i--) {
      const point = combinedData[i];
      if (point.bloodSugar && point.bloodSugar !== null && point.timestamp <= now) {
        lastActualReading = point.bloodSugar;
        lastReadingTime = point.timestamp;
        break;
      }
    }

    if (closestPoint && minDiff < 15 * 60 * 1000) {
      const mealImpact = closestPoint.mealImpactMgdL || 0;
      const insulinImpact = Math.abs(closestPoint.insulinImpactMgdL || 0);

      // Get actual current blood sugar reading if available
      const currentBloodSugar = closestPoint.bloodSugar || closestPoint.estimatedBloodSugar || targetGlucose;

      // Calculate net effect of meals and insulin
      const netEffectMgdL = closestPoint.netEffectMgdL || (mealImpact - insulinImpact);

      // Estimated blood sugar after applying all factors
      const estimatedBloodSugar = currentBloodSugar + netEffectMgdL;

      return {
        projectedEffect: Math.round(netEffectMgdL * 10) / 10,
        mealImpact: Math.round(mealImpact * 10) / 10,
        insulinImpact: Math.round(insulinImpact * 10) / 10,
        baseline: Math.round(currentBloodSugar),
        projected: Math.round(estimatedBloodSugar),
        lastActualReading: lastActualReading ? Math.round(lastActualReading) : null,
        lastReadingTime: lastReadingTime,
        timestamp: now
      };
    }
    return null;
  }, [combinedData, targetGlucose]);

  useEffect(() => {
    const updateEffect = () => {
      const projectedEffectData = calculateCurrentProjectedEffect();
      setDisplayValue(projectedEffectData);
      updateNetEffect(projectedEffectData);
    };

    updateEffect();
    const interval = setInterval(updateEffect, 120000); // 2 minutes

    return () => clearInterval(interval);
  }, [calculateCurrentProjectedEffect, updateNetEffect]);

  const getStatusColor = (projectedEffect) => {
    if (projectedEffect > 50) return '#ff4444';
    if (projectedEffect > 20) return '#ff8800';
    if (projectedEffect < -50) return '#4CAF50';
    if (projectedEffect < -20) return '#82ca9d';
    return '#666666';
  };

  const getStatusText = (projectedEffect) => {
    if (projectedEffect > 50) return 'High Rising';
    if (projectedEffect > 20) return 'Rising';
    if (projectedEffect > 5) return 'Slightly Rising';
    if (projectedEffect < -50) return 'Rapidly Falling';
    if (projectedEffect < -20) return 'Falling';
    if (projectedEffect < -5) return 'Slightly Falling';
    return 'Stable';
  };

  if (!displayValue) {
    return (
      <div className="net-effect-container">
        <div className="net-effect-no-data">
          ⏳ Calculating estimated net effect...
        </div>
      </div>
    );
  }

  const statusColor = getStatusColor(displayValue.projectedEffect);
  const statusText = getStatusText(displayValue.projectedEffect);

  return (
    <div className="net-effect-container">
      <div className="net-effect-main">
        <div className="net-effect-label">Estimated Blood Sugar</div>
        <div className="net-effect-value" style={{
          color: displayValue.projected > targetGlucose * 1.3 ? '#ff4444' :
                 displayValue.projected < targetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
        }}>
          {displayValue.projected} mg/dL
        </div>
        <div className="net-effect-status" style={{ color: statusColor }}>
          {statusText} ({displayValue.projectedEffect > 0 ? '+' : ''}{displayValue.projectedEffect} mg/dL)
        </div>
      </div>

      <div className="net-effect-breakdown">
        {displayValue.lastActualReading && (
          <div className="breakdown-item last-reading">
            <span className="breakdown-label">Last Actual Reading:</span>
            <span className="breakdown-value" style={{
              color: displayValue.lastActualReading > targetGlucose * 1.3 ? '#ff4444' :
                     displayValue.lastActualReading < targetGlucose * 0.7 ? '#ff8800' : '#4CAF50',
              fontWeight: 'bold'
            }}>
              {displayValue.lastActualReading} mg/dL
              <span style={{ fontSize: '0.85em', fontWeight: 'normal', marginLeft: '8px' }}>
                ({new Date(displayValue.lastReadingTime).toLocaleTimeString()})
              </span>
            </span>
          </div>
        )}
        <div className="breakdown-item">
          <span className="breakdown-label">Current Reading:</span>
          <span className="breakdown-value">
            {displayValue.baseline} mg/dL
          </span>
        </div>
        <div className="breakdown-item">
          <span className="breakdown-label">Meal Impact:</span>
          <span className="breakdown-value meal-impact">
            +{displayValue.mealImpact} mg/dL
          </span>
        </div>
        <div className="breakdown-item">
          <span className="breakdown-label">Insulin Impact:</span>
          <span className="breakdown-value insulin-impact">
            -{displayValue.insulinImpact} mg/dL
          </span>
        </div>
      </div>

      <div className="net-effect-projected">
        <div className="projected-label">Net Effect Calculation</div>
        <div className="projected-value">
          <span className="baseline">{displayValue.baseline}</span>
          <span className="arrow">{displayValue.projectedEffect > 0 ? '+' : ''}{displayValue.projectedEffect}</span>
          <span className="arrow">=</span>
          <span 
            className="final"
            style={{ 
              color: displayValue.projected > targetGlucose * 1.3 ? '#ff4444' :
                     displayValue.projected < targetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
            }}
          >
            {displayValue.projected} mg/dL
          </span>
        </div>
      </div>

      <div className="net-effect-update-time">
        Last updated: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : 'Never'}
        <span className="next-update"> • Updates every 2 minutes</span>
      </div>
    </div>
  );
};

export default NetEffectDisplay;




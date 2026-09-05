import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import axios from 'axios';
import moment from 'moment';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Area,
  ReferenceLine
} from 'recharts';
import { useTable, useSortBy, usePagination } from 'react-table';
import { useConstants } from '../contexts/ConstantsContext';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import TimeManager from '../utils/TimeManager';
import TimeContext from '../contexts/TimeContext';
import TimeInput from '../components/TimeInput';
import './Charts/global-visualization.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Chart rendering error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h3>Chart Rendering Error</h3>
          <p>There was a problem displaying the chart. Try reducing the date range or refreshing the page.</p>
          <button onClick={() => this.setState({ hasError: false })}>Try Again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const CombinedGlucoseInsulinChart = ({ isDoctor = false, patientId = null }) => {
  const timeContext = useContext(TimeContext);
  const { patientConstants } = useConstants();
  const {
    filteredData: bloodSugarData,
    combinedData: allBloodSugarData,
    targetGlucose,
    dateRange,
    setDateRange,
    applyInsulinEffect,
    timeScale,
    unit
  } = useBloodSugarData();

  // State management
  const [insulinData, setInsulinData] = useState([]);
  const [combinedData, setCombinedData] = useState([]);
  const [optimizedData, setOptimizedData] = useState([]);
  const [insulinTypes, setInsulinTypes] = useState([]);
  const [selectedInsulinTypes, setSelectedInsulinTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showActualBloodSugar, setShowActualBloodSugar] = useState(true);
  const [showExpectedEffect, setShowExpectedEffect] = useState(true);
  const [activeView, setActiveView] = useState('chart');
  const [viewMode, setViewMode] = useState('combined');
  const [includeFutureEffect, setIncludeFutureEffect] = useState(true);
  const [futureHours, setFutureHours] = useState(7);
  const [dataPointCount, setDataPointCount] = useState(0);
  const [effectDurationHours, setEffectDurationHours] = useState(5);

  const userTimeZone = useMemo(() => TimeManager.getUserTimeZone(), []);

  // Helper functions
  const getInsulinParameters = useCallback((insulinType) => {
    const defaultParams = {
      onset_hours: 0.5,
      peak_hours: 2,
      duration_hours: 5,
      type: 'short_acting'
    };
    const medicationFactors = patientConstants?.medication_factors || {};
    return medicationFactors[insulinType] || defaultParams;
  }, [patientConstants]);

  const calculateInsulinEffect = useCallback((hoursSinceDose, dose, onsetHours, peakHours, durationHours) => {
    if (hoursSinceDose < 0 || hoursSinceDose > durationHours) return 0;

    if (peakHours === null) {
      if (hoursSinceDose < onsetHours) {
        return dose * (hoursSinceDose / onsetHours) * 0.5;
      } else {
        return dose * 0.5 * (1 - ((hoursSinceDose - onsetHours) / (durationHours - onsetHours)));
      }
    }

    let effect = 0;
    if (hoursSinceDose < peakHours) {
      if (hoursSinceDose < onsetHours) {
        effect = dose * (hoursSinceDose / onsetHours) * (peakHours / durationHours);
      } else {
        effect = dose * (hoursSinceDose / peakHours);
      }
    } else {
      effect = dose * (1 - ((hoursSinceDose - peakHours) / (durationHours - peakHours)));
    }

    return Math.max(0, effect);
  }, []);

  const getBidirectionalValue = useCallback((value) => {
    if (!value || value === 0) return null;
    return -Math.abs(value);
  }, []);

  const generateCombinedData = useCallback((insulinData, bloodGlucoseData) => {
    try {
      let allTimestamps = [
        ...insulinData.map(d => d.administrationTime),
        ...bloodGlucoseData.map(d => d.readingTime)
      ].filter(Boolean);

      if (allTimestamps.length === 0) return [];

      const minTime = Math.min(...allTimestamps);
      let maxTime = Math.max(...allTimestamps);

      if (includeFutureEffect) {
        const futureTime = moment().add(futureHours, 'hours').valueOf();
        maxTime = Math.max(maxTime, futureTime);
      }

      let interval = 15 * 60 * 1000;
      const rangeInDays = (maxTime - minTime) / (24 * 60 * 60 * 1000);

      if (rangeInDays > 14) interval = 60 * 60 * 1000;
      if (rangeInDays > 30) interval = 3 * 60 * 60 * 1000;

      const timelineData = [];
      let currentTime = minTime;
      let pointCount = 0;
      const MAX_DATA_POINTS = 2000;

      const exactBloodSugarMap = new Map();
      bloodGlucoseData.forEach(reading => {
        if (reading.isActualReading) {
          exactBloodSugarMap.set(reading.readingTime, reading);
        }
      });

      const includedReadings = new Set();

      while (currentTime <= maxTime && pointCount < MAX_DATA_POINTS) {
        pointCount++;
        const timePoint = {
          timestamp: currentTime,
          formattedTime: TimeManager.formatDate(currentTime, TimeManager.formats.DATETIME_DISPLAY),
          insulinDoses: {},
          insulinBars: {},
          insulinEffects: {},
          insulinEffectValues: {},
          totalInsulinEffect: 0,
          totalInsulinEffectValue: 0,
          isActualReading: false,
          dataType: 'estimated'
        };

        const exactBSReading = exactBloodSugarMap.get(currentTime);
        if (exactBSReading) {
          timePoint.bloodSugar = exactBSReading.bloodSugar;
          timePoint.bloodSugarStatus = exactBSReading.status;
          timePoint.isActualReading = true;
          timePoint.dataType = 'actual';
          includedReadings.add(currentTime);
        } else {
          const closestBloodSugar = bloodGlucoseData.find(bs =>
            !includedReadings.has(bs.readingTime) &&
            Math.abs(bs.readingTime - currentTime) < interval / 2
          );

          if (closestBloodSugar) {
            timePoint.bloodSugar = closestBloodSugar.bloodSugar;
            timePoint.predictedBloodSugar = closestBloodSugar.predictedBloodSugar;
            timePoint.bloodSugarStatus = closestBloodSugar.status;
            timePoint.bloodSugarNotes = closestBloodSugar.notes;
            timePoint.readingTime = closestBloodSugar.readingTime;
            timePoint.isActualReading = closestBloodSugar.isActualReading;
            timePoint.dataType = closestBloodSugar.dataType || (closestBloodSugar.isActualReading ? 'actual' : 'estimated');
            timePoint.isInterpolated = closestBloodSugar.isInterpolated;
            timePoint.isEstimated = closestBloodSugar.isEstimated;
            includedReadings.add(closestBloodSugar.readingTime);
          }
        }

        insulinData.forEach(dose => {
          if (Math.abs(dose.administrationTime - currentTime) < interval / 2) {
            const key = dose.medication;
            timePoint.insulinDoses[key] = (timePoint.insulinDoses[key] || 0) + dose.dose;
            timePoint.insulinBars[key] = getBidirectionalValue((timePoint.insulinDoses[key]));

            if (!timePoint.insulinDetails) timePoint.insulinDetails = [];
            timePoint.insulinDetails.push({
              type: dose.medication,
              dose: dose.dose,
              time: dose.administrationTime,
              formattedTime: dose.formattedTime,
              mealType: dose.mealType,
              notes: dose.notes
            });
          }

          const hoursSinceDose = (currentTime - dose.administrationTime) / (60 * 60 * 1000);

          if (hoursSinceDose >= 0 || includeFutureEffect) {
            const insulinParams = getInsulinParameters(dose.medication);
            const effect = calculateInsulinEffect(
              hoursSinceDose,
              dose.dose,
              insulinParams.onset_hours,
              insulinParams.peak_hours,
              insulinParams.duration_hours
            );

            if (effect > 0) {
              const key = dose.medication;
              timePoint.insulinEffects[key] = (timePoint.insulinEffects[key] || 0) + effect;
              timePoint.totalInsulinEffect += effect;
              timePoint.insulinEffectValues[key] = getBidirectionalValue(timePoint.insulinEffects[key]);
              timePoint.totalInsulinEffectValue = getBidirectionalValue(timePoint.totalInsulinEffect);
            }
          }
        });

        if (timePoint.totalInsulinEffect !== 0 && timePoint.bloodSugar && !timePoint.isActualReading) {
          const baseValue = timePoint.bloodSugar;
          const insulinImpact = 40 * timePoint.totalInsulinEffect;
          timePoint.predictedBloodSugar = baseValue - insulinImpact;
        }

        timelineData.push(timePoint);
        currentTime += interval;
      }

      setDataPointCount(timelineData.length);
      timelineData.sort((a, b) => a.timestamp - b.timestamp);
      return timelineData;
    } catch (error) {
      console.error('Error generating combined data:', error);
      return [];
    }
  }, [calculateInsulinEffect, getInsulinParameters, includeFutureEffect, futureHours, getBidirectionalValue]);

  const optimizeDataForChart = useCallback((data) => {
    if (!data || data.length === 0) return [];

    if (data.length > 1000) {
      const pointsWithDoses = data.filter(point =>
        Object.values(point.insulinDoses).some(dose => dose > 0)
      );

      const actualReadings = data.filter(point =>
        point.isActualReading && !point.isEstimated
      );

      const samplingRate = Math.ceil(data.length / 800);
      const sampledPoints = data.filter((_, index) => index % samplingRate === 0);

      const uniqueTimestamps = new Set();
      const optimized = [...pointsWithDoses, ...actualReadings, ...sampledPoints]
        .filter(point => {
          if (uniqueTimestamps.has(point.timestamp)) return false;
          uniqueTimestamps.add(point.timestamp);
          return true;
        })
        .sort((a, b) => a.timestamp - b.timestamp);

      return optimized;
    }

    return data;
  }, []);

  const fetchInsulinData = useCallback(async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authentication token not found');

      const timeSettings = timeContext && timeContext.getAPITimeSettings
        ? timeContext.getAPITimeSettings()
        : {
            startDate: timeContext ? timeContext.dateRange.start : dateRange.start,
            endDate: moment(timeContext ? timeContext.dateRange.end : dateRange.end)
              .add(includeFutureEffect ? futureHours : 0, 'hours')
              .format('YYYY-MM-DD')
          };

      const insulinResponse = await axios.get(
        `${API_BASE_URL}/api/insulin-data?start_date=${timeSettings.startDate}&end_date=${timeSettings.endDate}${patientId ? `&patient_id=${patientId}` : ''}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const insulinLogs = insulinResponse.data.insulin_logs || [];
      const types = [...new Set(insulinLogs.map(log => log.medication))];
      setInsulinTypes(types);

      if (selectedInsulinTypes.length === 0 && types.length > 0) {
        setSelectedInsulinTypes(types);
      }

      const processedInsulinData = insulinLogs.map(log => {
        const adminTime = moment(log.taken_at).valueOf();
        return {
          id: log.id || `insulin-${adminTime}`,
          medication: log.medication,
          dose: log.dose,
          administrationTime: adminTime,
          formattedTime: TimeManager.formatDate(adminTime, TimeManager.formats.DATETIME_DISPLAY),
          notes: log.notes || '',
          mealType: log.meal_type || 'N/A',
          bloodSugar: log.blood_sugar,
          suggestedDose: log.suggested_dose,
          pharmacokinetics: log.pharmacokinetics || getInsulinParameters(log.medication)
        };
      });

      const startDate = moment(timeSettings.startDate).startOf('day').valueOf();
      const filteredInsulinData = processedInsulinData.filter(insulin => insulin.administrationTime >= startDate);

      setInsulinData(filteredInsulinData);

      let processedData;
      if (allBloodSugarData && allBloodSugarData.length > 0) {
        processedData = applyInsulinEffect(filteredInsulinData, allBloodSugarData);
      } else {
        processedData = [];
      }

      const combinedResult = generateCombinedData(filteredInsulinData, processedData);
      setCombinedData(combinedResult);

      const optimizedResult = optimizeDataForChart(combinedResult);
      setOptimizedData(optimizedResult);

      setError('');
    } catch (error) {
      console.error('Error fetching insulin data:', error);
      setError('Failed to load insulin data. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [timeContext, dateRange, includeFutureEffect, futureHours, patientId, selectedInsulinTypes.length,
      getInsulinParameters, allBloodSugarData, applyInsulinEffect, generateCombinedData, optimizeDataForChart]);

  useEffect(() => {
    if (allBloodSugarData && allBloodSugarData.length > 0) {
      const processedData = applyInsulinEffect(insulinData, allBloodSugarData);
      const combinedResult = generateCombinedData(insulinData, processedData);
      setCombinedData(combinedResult);
      const optimizedResult = optimizeDataForChart(combinedResult);
      setOptimizedData(optimizedResult);
    }
  }, [allBloodSugarData, applyInsulinEffect, generateCombinedData, insulinData, optimizeDataForChart]);

  useEffect(() => {
    fetchInsulinData();
  }, [timeContext?.dateRange]);

  const handleInsulinTypeToggle = useCallback((insulinType) => {
    setSelectedInsulinTypes(prev =>
      prev.includes(insulinType) ? prev.filter(type => type !== insulinType) : [...prev, insulinType]
    );
  }, []);

  const formatXAxis = useCallback((tickItem) => {
    return TimeManager.formatAxisTick(tickItem, timeScale.tickFormat || 'CHART_TICKS_MEDIUM');
  }, [timeScale]);

  const ticks = useMemo(() => {
    return TimeManager.generateTimeTicks(timeScale.start, timeScale.end, timeScale.tickInterval || 12);
  }, [timeScale]);

  const getInsulinColor = useCallback((insulinType, index, isEffect = false) => {
    const colorMap = {
      'rapid_acting': '#8884d8',
      'short_acting': '#82ca9d',
      'intermediate_acting': '#ffc658',
      'long_acting': '#ff8042',
      'ultra_long_acting': '#0088fe',
    };

    const baseColor = colorMap[insulinType] || [
      '#8884d8', '#82ca9d', '#ffc658', '#ff8042', '#0088fe',
      '#00C49F', '#FFBB28', '#FF8042', '#a4de6c', '#d0ed57'
    ][index % 10];

    if (isEffect) {
      let r = parseInt(baseColor.substring(1, 3), 16);
      let g = parseInt(baseColor.substring(3, 5), 16);
      let b = parseInt(baseColor.substring(5, 7), 16);
      r = Math.max(0, r - 20);
      g = Math.max(0, g - 20);
      b = Math.max(0, b - 20);
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    return baseColor;
  }, []);

  const CustomTooltip = useCallback(({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="insulin-tooltip">
          <p className="tooltip-time">{data.formattedTime}</p>
          {data.insulinDetails && data.insulinDetails.length > 0 && (
            <div className="tooltip-section">
              <p className="tooltip-header">Insulin Doses:</p>
              {data.insulinDetails.map((insulin, idx) => (
                <p key={idx} className="tooltip-dose">
                  {insulin.type.replace(/_/g, ' ')} - {insulin.dose} units
                  {insulin.mealType !== 'N/A' && ` (${insulin.mealType.replace(/_/g, ' ')})`}
                </p>
              ))}
            </div>
          )}
          {data.totalInsulinEffect > 0 && (
            <div className="tooltip-section">
              <p className="tooltip-header">Active Insulin Effect:</p>
              <p className="tooltip-effect">Total Effect: {data.totalInsulinEffect.toFixed(2)} units</p>
              {Object.entries(data.insulinEffects || {}).map(([type, effect], idx) =>
                effect > 0 && (
                  <p key={idx} className="tooltip-effect-detail">
                    {type.replace(/_/g, ' ')}: {effect.toFixed(2)} units
                  </p>
                )
              )}
            </div>
          )}
          {data.bloodSugar && (
            <div className="tooltip-section">
              <p className="tooltip-header">Blood Sugar:</p>
              <p className="tooltip-blood-sugar">
                {data.bloodSugar} {unit}
                {data.bloodSugarStatus && ` (${data.bloodSugarStatus.label})`}
                {data.isEstimated && ' - Estimated'}
                {data.isActualReading && ' - Actual Reading'}
              </p>
            </div>
          )}
          {data.predictedBloodSugar && (
            <div className="tooltip-section">
              <p className="tooltip-header">Predicted Blood Sugar:</p>
              <p className="tooltip-predicted-bg">
                ~{Math.round(data.predictedBloodSugar)} {unit} (with insulin effect)
              </p>
            </div>
          )}
        </div>
      );
    }
    return null;
  }, [unit]);

  const CustomBloodSugarDot = useCallback((props) => {
    const { cx, cy, payload } = props;
    if (!payload.isActualReading) return null;

    const dotColor = payload.bloodSugarStatus ?
      payload.bloodSugarStatus.color :
      (payload.bloodSugar > targetGlucose ? '#ff8800' : '#00C851');

    return <circle cx={cx} cy={cy} r={4} stroke={dotColor} strokeWidth={2} fill="#ffffff" />;
  }, [targetGlucose]);

  const columns = useMemo(() => [
    {
      Header: 'Time',
      accessor: 'formattedTime',
      sortType: (a, b) => a.original.administrationTime - b.original.administrationTime
    },
    {
      Header: 'Insulin Type',
      accessor: 'medication',
      Cell: ({ value }) => value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    },
    { Header: 'Dose (units)', accessor: 'dose' },
    {
      Header: 'Blood Sugar',
      accessor: 'bloodSugar',
      Cell: ({ value }) => value ? `${value} ${unit}` : 'N/A'
    },
    {
      Header: 'Suggested Dose',
      accessor: 'suggestedDose',
      Cell: ({ value }) => value ? `${value} units` : 'N/A'
    },
    {
      Header: 'Meal Type',
      accessor: 'mealType',
      Cell: ({ value }) => value.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    },
    {
      Header: 'Notes',
      accessor: 'notes',
      Cell: ({ value }) => value || 'No notes'
    }
  ], [unit]);

  const filteredInsulinData = useMemo(() =>
    insulinData.filter(item => selectedInsulinTypes.includes(item.medication)),
    [insulinData, selectedInsulinTypes]
  );

  const tableInstance = useTable(
    { columns, data: filteredInsulinData, initialState: { pageIndex: 0, pageSize: 10 } },
    useSortBy,
    usePagination
  );

  const {
    getTableProps, getTableBodyProps, headerGroups, page, prepareRow,
    canPreviousPage, canNextPage, pageCount, gotoPage, nextPage, previousPage,
    setPageSize, state: { pageIndex, pageSize }
  } = tableInstance;

  const currentTimeYAxisId = useMemo(() => {
    if (showActualBloodSugar) return "bloodSugar";
    return "insulinDose";
  }, [showActualBloodSugar]);

  const currentTimeInRange = TimeManager.isTimeInRange(
    new Date().getTime(),
    timeScale.start,
    timeScale.end
  );

  return (
    <div className="insulin-visualization">
      <h2 className="title">Meal & Insulin Impact Chart</h2>

      <div className="timezone-info">
        Your timezone: {userTimeZone} <span className="timezone-note">(all times displayed in your local timezone)</span>
      </div>

      <div className="view-toggle">
        <button className={`toggle-btn ${activeView === 'chart' ? 'active' : ''}`} onClick={() => setActiveView('chart')}>Chart View</button>
        <button className={`toggle-btn ${activeView === 'table' ? 'active' : ''}`} onClick={() => setActiveView('table')}>Table View</button>
      </div>

      {activeView === 'chart' && (
        <div className="view-mode-toggle">
          <button className={`toggle-btn ${viewMode === 'combined' ? 'active' : ''}`} onClick={() => setViewMode('combined')}>Combined View</button>
          <button className={`toggle-btn ${viewMode === 'doses' ? 'active' : ''}`} onClick={() => setViewMode('doses')}>Insulin Doses</button>
          <button className={`toggle-btn ${viewMode === 'effect' ? 'active' : ''}`} onClick={() => setViewMode('effect')}>Insulin Effect</button>
        </div>
      )}

      <div className="controls">
        <TimeInput
          mode="daterange"
          value={timeContext ? timeContext.dateRange : dateRange}
          onChange={timeContext ? timeContext.handleDateRangeChange : setDateRange}
          useTimeContext={!!timeContext}
          label="Date Range"
          className="date-range-control"
        />

        <div className="insulin-type-filters">
          <div className="filter-header">Insulin Types:</div>
          <div className="filter-options">
            {insulinTypes.map((type, idx) => (
              <label key={`${type}_${idx}`} className="filter-option">
                <input type="checkbox" checked={selectedInsulinTypes.includes(type)} onChange={() => handleInsulinTypeToggle(type)} />
                <span style={{color: getInsulinColor(type, idx)}}>
                  {type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="display-options">
          <label className="display-option">
            <input type="checkbox" checked={showActualBloodSugar} onChange={() => setShowActualBloodSugar(!showActualBloodSugar)} />
            Show Blood Sugar
          </label>
          <label className="display-option">
            <input type="checkbox" checked={showExpectedEffect} onChange={() => setShowExpectedEffect(!showExpectedEffect)} />
            Show Insulin Effect
          </label>
          <label className="display-option">
            <input type="checkbox" checked={includeFutureEffect} onChange={() => setIncludeFutureEffect(!includeFutureEffect)} />
            Project Future Effect
          </label>
          {includeFutureEffect && (
            <div className="future-hours">
              <label>Future Hours:</label>
              <input type="number" min="1" max="24" value={futureHours} onChange={(e) => setFutureHours(parseInt(e.target.value) || 7)} />
            </div>
          )}
          <div className="effect-duration">
            <label>Effect Duration (hours):</label>
            <input type="number" min="1" max="24" value={effectDurationHours} onChange={(e) => setEffectDurationHours(parseInt(e.target.value) || 5)} />
          </div>
        </div>

        <button className="update-btn" onClick={fetchInsulinData}>Update Data</button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading insulin data...</div>
      ) : optimizedData.length === 0 ? (
        <div className="no-data">No insulin data found for the selected date range.</div>
      ) : (
        <div className="content-container">
          {activeView === 'chart' && (
            <div className="chart-container">
              <ErrorBoundary>
                <ResponsiveContainer width="100%" height={500}>
                  <ComposedChart data={optimizedData} margin={{ top: 5, right: 30, left: 20, bottom: 25 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      scale="time"
                      domain={[timeScale.start, timeScale.end]}
                      ticks={ticks}
                      tickFormatter={formatXAxis}
                      angle={-45}
                      textAnchor="end"
                      height={70}
                    />

                    {showActualBloodSugar && (
                      <YAxis yAxisId="bloodSugar" orientation="left" domain={['dataMin - 20', 'dataMax + 20']}
                        tickFormatter={(value) => Math.round(value)}
                        label={{ value: `Blood Sugar (${unit})`, angle: -90, position: 'insideLeft' }} />
                    )}

                    {(viewMode === 'combined' || viewMode === 'doses') && (
                      <YAxis yAxisId="insulinDose" orientation={showActualBloodSugar ? "right" : "left"}
                        domain={[-30, 0]}
                        ticks={[-30, -25, -20, -15, -10, -5, 0]}
                        tickFormatter={(value) => Math.abs(value)}
                        label={{ value: 'Insulin Dose (units)', angle: -90, position: showActualBloodSugar ? 'insideRight' : 'insideLeft' }} />
                    )}

                    {(viewMode === 'combined' || viewMode === 'effect') && showExpectedEffect && (
                      <YAxis yAxisId="insulinEffect" orientation="right"
                        domain={[-5, 0]}
                        ticks={[-5, -4, -3, -2, -1, 0]}
                        tickFormatter={(value) => Math.abs(value)}
                        label={{ value: 'Active Insulin (units)', angle: -90, position: 'insideRight' }} />
                    )}

                    <Tooltip content={<CustomTooltip />} />
                    <Legend />

                    {(viewMode === 'combined' || viewMode === 'doses') && (
                      <ReferenceLine y={0} yAxisId="insulinDose" stroke="#888888" strokeWidth={1} />
                    )}

                    {showActualBloodSugar && (
                      <ReferenceLine y={targetGlucose} yAxisId="bloodSugar" label="Target" stroke="#FF7300" strokeDasharray="3 3" />
                    )}

                    {showActualBloodSugar && (
                      <>
                        <Line yAxisId="bloodSugar" type="monotone" dataKey="bloodSugar" name={`Blood Sugar (${unit})`}
                          stroke="#8884d8" dot={CustomBloodSugarDot} activeDot={{ r: 8 }} connectNulls />
                        <Line yAxisId="bloodSugar" type="monotone" dataKey="predictedBloodSugar" name={`Predicted with Insulin (${unit})`}
                          stroke="#00C853" strokeWidth={1.5} strokeDasharray="5 2" dot={{ r: 2 }} connectNulls />
                      </>
                    )}

                    {(viewMode === 'combined' || viewMode === 'doses') && selectedInsulinTypes.map((insulinType, idx) => (
                      <Bar key={`dose-${insulinType}-${idx}`} yAxisId="insulinDose" dataKey={`insulinBars.${insulinType}`}
                        name={`${insulinType.replace(/_/g, ' ')} Dose`} fill={getInsulinColor(insulinType, idx)}
                        barSize={80} fillOpacity={0.85} stroke={getInsulinColor(insulinType, idx)} strokeWidth={3} />
                    ))}

                    {(viewMode === 'combined' || viewMode === 'effect') && showExpectedEffect && (
                      <Area yAxisId="insulinEffect" type="monotone" dataKey="totalInsulinEffectValue" name="Total Active Insulin"
                        fill="#82ca9d" stroke="#82ca9d" fillOpacity={0.3} />
                    )}

                    {(viewMode === 'combined' || viewMode === 'effect') && showExpectedEffect &&
                      selectedInsulinTypes.map((insulinType, idx) => (
                        <Line key={`effect-${insulinType}-${idx}`} yAxisId="insulinEffect" type="monotone"
                          dataKey={`insulinEffectValues.${insulinType}`} name={`${insulinType.replace(/_/g, ' ')} Effect`}
                          stroke={getInsulinColor(insulinType, idx, true)} strokeWidth={1} strokeDasharray="3 3" dot={false} />
                      ))}

                    {currentTimeInRange && (
                      <ReferenceLine x={new Date().getTime()} yAxisId={currentTimeYAxisId} stroke="#ff0000" strokeWidth={2}
                        label={{ value: 'Now', position: 'top', fill: '#ff0000' }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </ErrorBoundary>

              <div className="insulin-legend">
                <h4>Insulin Type Guide</h4>
                <div className="insulin-scale">
                  {insulinTypes.filter(type => selectedInsulinTypes.includes(type)).map((type, idx) => {
                    const params = getInsulinParameters(type);
                    return (
                      <div key={`legend-${type}-${idx}`} className="insulin-scale-item">
                        <span className="scale-color" style={{ backgroundColor: getInsulinColor(type, idx) }}></span>
                        <span className="scale-label">{type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                        <span className="scale-details">
                          Onset: {params.onset_hours}h |
                          {params.peak_hours ? ` Peak: ${params.peak_hours}h |` : ''}
                          Duration: {params.duration_hours}h
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="chart-legend">
                <h4>Chart Explanation</h4>
                <div className="chart-explanation">
                  <div className="explanation-section">
                    <p><strong>Insulin Doses:</strong> Shown as bars extending downward. Taller bars represent larger doses.</p>
                    <p><strong>Active Insulin:</strong> The estimated amount of insulin still active in your body over time.</p>
                    <p><strong>Predicted Effect:</strong> Shows how insulin is expected to affect blood sugar levels.</p>
                  </div>
                  <div className="explanation-note">
                    <p><strong>Note:</strong> Insulin doses and effects are shown below the zero line.
                    Higher values extend further downward on the chart for clearer visualization.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeView === 'table' && (
            <div className="table-container">
              <table {...getTableProps()} className="insulin-table">
                <thead>
                  {headerGroups.map((headerGroup, i) => {
                    const { key, ...headerGroupProps } = headerGroup.getHeaderGroupProps();
                    return (
                      <tr key={`header-group-${i}`} {...headerGroupProps}>
                        {headerGroup.headers.map((column, j) => {
                          const { key, ...columnProps } = column.getHeaderProps(column.getSortByToggleProps());
                          return (
                            <th key={`header-${i}-${j}`} {...columnProps}>
                              {column.render('Header')}
                              <span>{column.isSorted ? (column.isSortedDesc ? ' 🔽' : ' 🔼') : ''}</span>
                            </th>
                          );
                        })}
                      </tr>
                    );
                  })}
                </thead>
                <tbody {...getTableBodyProps()}>
                  {page.length > 0 ? (
                    page.map((row, i) => {
                      prepareRow(row);
                      const { key, ...rowProps } = row.getRowProps();
                      return (
                        <tr key={`row-${i}`} {...rowProps}>
                          {row.cells.map((cell, j) => {
                            const { key, ...cellProps } = cell.getCellProps();
                            return <td key={`cell-${i}-${j}`} {...cellProps}>{cell.render('Cell')}</td>;
                          })}
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={columns.length} className="no-data">
                        No insulin data found for the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="pagination">
                <button onClick={() => gotoPage(0)} disabled={!canPreviousPage}>{'<<'}</button>
                <button onClick={() => previousPage()} disabled={!canPreviousPage}>{'<'}</button>
                <button onClick={() => nextPage()} disabled={!canNextPage}>{'>'}</button>
                <button onClick={() => gotoPage(pageCount - 1)} disabled={!canNextPage}>{'>>'}</button>
                <span>Page <strong>{pageIndex + 1} of {Math.max(1, pageCount)}</strong></span>
                <span>
                  | Go to page: <input type="number" defaultValue={pageIndex + 1}
                    onChange={e => { const page = e.target.value ? Number(e.target.value) - 1 : 0; gotoPage(page); }} />
                </span>
                <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
                  {[10, 20, 30, 40, 50].map(size => <option key={size} value={size}>Show {size}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="data-info">
        <span>Displaying {optimizedData.length} data points</span>
        {optimizedData.length < combinedData.length &&
          <span className="optimization-note"> (optimized from {combinedData.length} total points)</span>
        }
      </div>
    </div>
  );
};

export default CombinedGlucoseInsulinChart;





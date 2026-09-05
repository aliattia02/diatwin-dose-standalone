import API_BASE_URL from '../config';
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import axios from 'axios';
import moment from 'moment';
import styles from './Charts/global-visualization.css';

const BloodSugarChart = ({ isDoctor = false, patientId = null }) => {
  const [data, setData] = useState([]);
  const [targetGlucose, setTargetGlucose] = useState(100);
  const [dateRange, setDateRange] = useState({
    start: moment().subtract(7, 'days').format('DD-MM-YYYY'),
    end: moment().add(1, 'day').format('DD-MM-YYYY')
  });
  const [error, setError] = useState('');
  const [unit, setUnit] = useState('mg/dL');

  useEffect(() => {
    fetchData();
  }, [dateRange, isDoctor, patientId, unit]);

  const fetchData = async () => {
    try {
      const token = localStorage.getItem('token');
      // Convert DD-MM-YYYY to YYYY-MM-DD for API request
      const startDate = moment(dateRange.start, 'DD-MM-YYYY').format('YYYY-MM-DD');
      const endDate = moment(dateRange.end, 'DD-MM-YYYY').format('YYYY-MM-DD');

      let url = `${API_BASE_URL}/api/blood-sugar?start_date=${startDate}&end_date=${endDate}&unit=${unit}`;
      if (isDoctor && patientId) {
        url = `${API_BASE_URL}/doctor/patient/${patientId}/blood-sugar?start_date=${startDate}&end_date=${endDate}&unit=${unit}`;
      }

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const formattedData = response.data.map(item => ({
        ...item,
        timestamp: new Date(item.timestamp).getTime(),
        status: getStatusColor(item.bloodSugar, targetGlucose)
      }));

      setData(formattedData);

      if (response.data.length > 0 && response.data[0].target) {
        setTargetGlucose(response.data[0].target);
      }

      setError('');
    } catch (error) {
      console.error('Error fetching blood sugar data:', error);
      setError('Failed to fetch blood sugar data. Please try again.');
    }
  };

  const getStatusColor = (bloodSugar, target) => {
    if (bloodSugar < target * 0.7) return '#ff4444';
    if (bloodSugar > target * 1.3) return '#ff8800';
    return '#00C851';
  };

  const handleDateChange = (e) => {
    const { name, value } = e.target;
    // Convert YYYY-MM-DD to DD-MM-YYYY for display
    const formattedDate = moment(value, 'YYYY-MM-DD').format('DD-MM-YYYY');
    setDateRange(prev => ({ ...prev, [name]: formattedDate }));
  };

  const handleUnitChange = (e) => {
    setUnit(e.target.value);
  };

  const formatXAxis = (tickItem) => {
    return moment(tickItem).format('DD-MM HH:mm');
  };

  const formatYAxis = (value) => {
    return `${value} ${unit}`;
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const reading = payload[0].payload;
      return (
        <div className={styles.customTooltip}>
          <p className={styles.time}>{`Time: ${moment(label).format('DD-MM-YYYY HH:mm')}`}</p>
          <p className={styles.value} style={{ color: reading.status }}>
            {`Blood Sugar: ${payload[0].value} ${unit}`}
          </p>
          <p className={styles.status}>
            {reading.bloodSugar < targetGlucose * 0.7 ? 'Low' :
             reading.bloodSugar > targetGlucose * 1.3 ? 'High' : 'Normal'}
          </p>
        </div>
      );
    }
    return null;
  };

  // Convert dates back to YYYY-MM-DD for input elements
  const inputStartDate = moment(dateRange.start, 'DD-MM-YYYY').format('YYYY-MM-DD');
  const inputEndDate = moment(dateRange.end, 'DD-MM-YYYY').format('YYYY-MM-DD');

  return (
    <div className={styles.bloodSugarChart}>
      <h2 className={styles.title}>Blood Sugar Chart</h2>
      <div className={styles.controls}>
        <div className={styles.dateInputs}>
          <div className={styles.inputWrapper}>
            <label htmlFor="start-date">Start Date:</label>
            <input
              id="start-date"
              type="date"
              name="start"
              value={inputStartDate}
              onChange={handleDateChange}
              className={styles.input}
            />
            <span className={styles.dateDisplay}>{dateRange.start}</span>
          </div>
          <div className={styles.inputWrapper}>
            <label htmlFor="end-date">End Date:</label>
            <input
              id="end-date"
              type="date"
              name="end"
              value={inputEndDate}
              onChange={handleDateChange}
              className={styles.input}
            />
            <span className={styles.dateDisplay}>{dateRange.end}</span>
          </div>
        </div>
        <div className={styles.unitSelector}>
          <label htmlFor="unit">Unit:</label>
          <select
            id="unit"
            value={unit}
            onChange={handleUnitChange}
            className={styles.select}
          >
            <option value="mg/dL">mg/dL</option>
            <option value="mmol/L">mmol/L</option>
          </select>
        </div>
        <button onClick={fetchData} className={styles.button}>Update Chart</button>
      </div>

       {error && <div className={styles.error}>{error}</div>}

      <div className={styles.chartContainer}>
        <ResponsiveContainer width="100%" height={400}>
          <LineChart
            data={data}
            margin={{ top: 5, right: 30, left: 20, bottom: 25 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={formatXAxis}
              angle={-45}
              textAnchor="end"
              height={70}
              interval="preserveStartEnd"
              allowDataOverflow={false}
              allowDecimals={true}
              allowDuplicatedCategory={true}
              hide={false}
              mirror={false}
              orientation="bottom"
              padding={{ left: 0, right: 0 }}
              reversed={false}
              tick={{ fontSize: 12 }}
              tickCount={5}
              xAxisId={0}
            />
            <YAxis
              tickFormatter={formatYAxis}
              domain={[
                dataMin => Math.max(0, dataMin * 0.8),
                dataMax => dataMax * 1.2
              ]}
              allowDataOverflow={false}
              allowDecimals={true}
              allowDuplicatedCategory={true}
              hide={false}
              mirror={false}
              orientation="left"
              padding={{ top: 0, bottom: 0 }}
              reversed={false}
              tick={{ fontSize: 12 }}
              tickCount={5}
              yAxisId={0}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            <ReferenceLine
              y={targetGlucose}
              label="Target"
              stroke="#666"
              strokeDasharray="3 3"
              isFront={false}
              labelPosition="right"
              segment={[]}
              xAxisId={0}
              yAxisId={0}
            />
            <ReferenceLine
              y={targetGlucose * 0.7}
              stroke="#ff4444"
              strokeDasharray="3 3"
              isFront={false}
              labelPosition="right"
              segment={[]}
              xAxisId={0}
              yAxisId={0}
            />
            <ReferenceLine
              y={targetGlucose * 1.3}
              stroke="#ff8800"
              strokeDasharray="3 3"
              isFront={false}
              labelPosition="right"
              segment={[]}
              xAxisId={0}
              yAxisId={0}
            />
            <Line
              type="monotone"
              dataKey="bloodSugar"
              stroke="#8884d8"
              dot={{ stroke: datum => datum.status, fill: datum => datum.status }}
              activeDot={{ r: 8 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default BloodSugarChart;





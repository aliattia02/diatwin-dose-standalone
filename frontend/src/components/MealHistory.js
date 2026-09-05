import API_BASE_URL from '../config';
import React, { useState, useEffect } from 'react';
import { useTable, useSortBy, usePagination } from 'react-table';
import axios from 'axios';
import moment from 'moment';
import { FaTrash, FaExclamationTriangle } from 'react-icons/fa';
import './Charts/dashboard-components.css'; // Updated import

const formatDateTime = (timestamp) => {
  if (!timestamp) return 'Invalid date';
  try {
    return moment.utc(timestamp).local().format('MM/DD/YYYY, HH:mm:ss');
  } catch (error) {
    return 'Invalid date';
  }
};

const formatFoodItems = (foodItems) => {
  if (!Array.isArray(foodItems) || foodItems.length === 0) return "No items";
  const formattedItems = foodItems
    .map(item => {
      if (!item?.name) return null;
      const amount = item.portion?.amount || '';
      const unit = item.portion?.unit || '';
      return `${amount} ${unit} ${item.name}`.trim();
    })
    .filter(Boolean);

  return formattedItems.length ? formattedItems.join(", ") : "No items";
};

const determineEntryType = (meal) => {
  if (meal.mealType === 'activity_only' || meal.recordingType === 'standalone_activity_recording') {
    return 'activity';
  }

  if (meal.mealType === 'blood_sugar_only' || (meal.bloodSugar && !meal.foodItems?.length && !meal.intendedInsulin)) {
    return 'blood_sugar';
  }

  if (meal.activity_ids?.length > 0 && (!meal.foodItems || meal.foodItems.length === 0)) {
    return 'activity';
  }

  if (meal.intendedInsulin && (!meal.foodItems || meal.foodItems.length === 0) && (!meal.activity_ids || meal.activity_ids.length === 0)) {
    return 'insulin';
  }

  return 'meal';
};

const MealHistory = ({ isDoctor = false, patientId = null }) => {
  const [allRecords, setAllRecords] = useState([]);
  const [filteredData, setFilteredData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState({ text: '', type: '' });
  const [selectedMeal, setSelectedMeal] = useState(null);
  const [userTimeZone, setUserTimeZone] = useState('');
  const [debug, setDebug] = useState({});
  const [recordToDelete, setRecordToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeFilter, setActiveFilter] = useState('all');
  const [pagination, setPagination] = useState({
    total: 0,
    filteredTotal: 0,
    limit: 20,
    fetchLimit: 200
  });

  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  useEffect(() => {
    if (message.text) {
      const timer = setTimeout(() => {
        setMessage({ text: '', type: '' });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const fetchAllRecords = async () => {
    try {
      setLoading(true);
      setMessage({ text: '', type: '' });
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Authentication token not found');
      }

      let url = `${API_BASE_URL}/api/meals`;
      if (isDoctor && patientId) {
        url = `${API_BASE_URL}/api/doctor/meal-history/${patientId}`;
      }

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          skip: 0,
          limit: pagination.fetchLimit
        }
      });

      setDebug(response.data);

      if (response.data.pagination) {
        setPagination(prev => ({
          ...prev,
          total: response.data.pagination.total
        }));
      }

      const meals = Array.isArray(response.data) ? response.data : response.data.meals || [];

      const processedMeals = meals.map(meal => {
        const entryType = determineEntryType(meal);

        return {
          ...meal,
          formattedTimestamp: formatDateTime(meal.timestamp),
          formattedBloodSugarTimestamp: formatDateTime(meal.bloodSugarTimestamp),
          mealType: meal.mealType || 'unknown',
          foodItems: meal.foodItems || [],
          activity_ids: meal.activity_ids || [],
          nutrition: meal.nutrition || {},
          id: meal.id || `temp_${Math.random().toString(36).substr(2, 9)}`,
          suggestedInsulin: meal.suggestedInsulin !== undefined ? meal.suggestedInsulin : 0,
          intendedInsulin: meal.intendedInsulin,
          entryType: entryType
        };
      });

      setAllRecords(processedMeals);
      applyFilter(activeFilter, processedMeals);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching meal history:', err);
      setError(err.message || 'Failed to load meal history');
      setLoading(false);
    }
  };

  const handleDeleteRecord = async () => {
    if (!recordToDelete) return;

    setIsDeleting(true);

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Authentication token not found');
      }

      let endpoint = `${API_BASE_URL}/api/meal/${recordToDelete.id}`;

      await axios.delete(endpoint, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const updatedRecords = allRecords.filter(record => record.id !== recordToDelete.id);
      setAllRecords(updatedRecords);

      const updatedFiltered = filteredData.filter(record => record.id !== recordToDelete.id);
      setFilteredData(updatedFiltered);

      setPagination(prev => ({
        ...prev,
        total: Math.max(0, (prev.total || 0) - 1),
        filteredTotal: Math.max(0, (prev.filteredTotal || 0) - 1)
      }));

      setMessage({
        text: `Successfully deleted ${getRecordTypeLabel(recordToDelete.entryType)} record`,
        type: 'success'
      });
    } catch (err) {
      console.error('Error deleting record:', err);
      setMessage({
        text: `Error deleting record: ${err.response?.data?.error || err.message}`,
        type: 'error'
      });
    } finally {
      setIsDeleting(false);
      setRecordToDelete(null);
    }
  };

  const getRecordTypeLabel = (entryType) => {
    switch (entryType) {
      case 'meal': return 'meal';
      case 'blood_sugar': return 'blood sugar';
      case 'activity': return 'activity';
      case 'insulin': return 'insulin';
      default: return 'record';
    }
  };

  const applyFilter = (filterType, records = allRecords) => {
    let filtered;

    if (filterType === 'all') {
      filtered = records;
    } else {
      filtered = records.filter(record => record.entryType === filterType);
    }

    setFilteredData(filtered);
    setPagination(prev => ({
      ...prev,
      filteredTotal: filtered.length
    }));
  };

  useEffect(() => {
    fetchAllRecords();
  }, [isDoctor, patientId]);

  const handleFilterChange = (newFilter) => {
    setActiveFilter(newFilter);
    applyFilter(newFilter);

    if (tableInstance.current) {
      tableInstance.current.gotoPage(0);
    }
  };

  const tableInstance = React.useRef(null);

  const ConfirmationDialog = ({ record, onCancel, onConfirm, isDeleting }) => {
    if (!record) return null;

    const recordType = getRecordTypeLabel(record.entryType);
    const hasRelatedData = record.activity_ids?.length > 0 || record.blood_sugar_id || record.medication_log_id;

    return (
      <div className="dash-history-modal-overlay" onClick={onCancel}>
        <div className="dash-history-modal-content dash-history-confirm-dialog" onClick={e => e.stopPropagation()}>
          <div className="dash-history-modal-header dash-history-warning">
            <div className="dash-history-warning-header">
              <FaExclamationTriangle className="dash-history-warning-icon" />
              <h3>Confirm Deletion</h3>
            </div>
            <button onClick={onCancel} disabled={isDeleting}>&times;</button>
          </div>
          <div className="dash-history-modal-body">
            <p className="dash-history-confirm-message">
              Are you sure you want to delete this {recordType} record from {record.formattedTimestamp}?
            </p>

            {hasRelatedData && (
              <div className="dash-history-warning-message">
                <FaExclamationTriangle className="dash-history-warning-icon-small" />
                <span>
                  This record has linked data that will also be deleted:
                  <ul>
                    {record.activity_ids?.length > 0 && <li>{record.activity_ids.length} activity records</li>}
                    {record.blood_sugar_id && <li>Blood sugar reading</li>}
                    {record.medication_log_id && <li>Insulin/medication log</li>}
                  </ul>
                </span>
              </div>
            )}

            <p className="dash-history-permanent-warning">This action cannot be undone.</p>

            <div className="dash-history-confirm-buttons">
              <button
                className="dash-history-cancel-button"
                onClick={onCancel}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="dash-history-delete-button"
                onClick={onConfirm}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const MealDetailsModal = ({ meal, onClose }) => {
    const [activityDetails, setActivityDetails] = useState([]);
    const [loadingActivities, setLoadingActivities] = useState(false);

    useEffect(() => {
      const fetchActivityDetails = async () => {
        if (meal.entryType === 'activity' && !meal.activity_ids?.length) {
          setActivityDetails([{
            id: meal.id,
            level: meal.level || 0,
            type: meal.type || 'unknown',
            duration: meal.duration || 'N/A',
            startTime: meal.startTime,
            endTime: meal.endTime,
            impact: meal.impact || 1.0,
            notes: meal.notes || ''
          }]);
          return;
        }

        if (meal.activity_ids?.length > 0) {
          try {
            setLoadingActivities(true);
            const token = localStorage.getItem('token');

            const activityPromises = meal.activity_ids.map(id =>
              axios.get(`${API_BASE_URL}/api/activity/${id}`, {
                headers: { Authorization: `Bearer ${token}` }
              })
            );

            const responses = await Promise.all(activityPromises);
            const fetchedActivities = responses.map(res => res.data);
            setActivityDetails(fetchedActivities);
          } catch (err) {
            console.error('Error fetching activity details:', err);
          } finally {
            setLoadingActivities(false);
          }
        }
      };

      fetchActivityDetails();
    }, [meal]);

    if (!meal) return null;

    return (
      <div className="dash-history-modal-overlay" onClick={onClose}>
        <div className="dash-history-modal-content" onClick={e => e.stopPropagation()}>
          <div className="dash-history-modal-header">
            <h3>
              {meal.entryType === 'blood_sugar' ? 'Blood Sugar Reading' :
               meal.entryType === 'activity' ? 'Activity Record' :
               meal.entryType === 'insulin' ? 'Insulin Record' :
               `${meal.mealType} - ${meal.formattedTimestamp}`}
            </h3>
            <button onClick={onClose}>&times;</button>
          </div>
          <div className="dash-history-modal-body">
            <div className="dash-history-meal-metrics">
              {meal.bloodSugar && (
                <div>
                  Blood Sugar: {meal.bloodSugar || 'N/A'} mg/dL
                  {meal.bloodSugarTimestamp && (
                    <div style={{ fontSize: '0.85em', color: '#666', marginTop: '3px', fontStyle: 'italic' }}>
                      Reading time: {formatDateTime(meal.bloodSugarTimestamp)}
                    </div>
                  )}
                </div>
              )}
              {meal.suggestedInsulin && <div>Suggested Insulin: {meal.suggestedInsulin || 'N/A'} units</div>}
              {meal.intendedInsulin && <div>Intended Insulin: {meal.intendedInsulin || 'N/A'} units</div>}
              {meal.imported_at && (
                <div style={{ fontSize: '0.85em', color: '#1890ff', marginTop: '3px' }}>
                  Imported on: {formatDateTime(meal.imported_at)}
                </div>
              )}
            </div>

            {meal.foodItems && meal.foodItems.length > 0 && (
              <>
                <h4>Food Items</h4>
                <ul>
                  {meal.foodItems.map((item, idx) => (
                    <li key={idx}>{item.portion?.amount} {item.portion?.unit} {item.name}</li>
                  ))}
                </ul>
              </>
            )}

            {(meal.activity_ids?.length > 0 || loadingActivities) && (
              <>
                <h4>Activities ({meal.activity_ids?.length || 0})</h4>
                {loadingActivities ? (
                  <div className="dash-history-loading-activities">Loading activity details...</div>
                ) : activityDetails.length > 0 ? (
                  <ul>
                    {activityDetails.map((activity, idx) => (
                      <li key={idx} className="dash-history-activity-item">
                        <div className="dash-history-activity-header">
                          <span>Level: {activity.level}</span>
                          {activity.type && <span>Type: {activity.type}</span>}
                        </div>
                        <div className="dash-history-activity-details">
                          <div>Duration: {activity.duration || 'N/A'}</div>
                          {activity.startTime && (
                            <div>
                              Time: {formatDateTime(activity.startTime)}
                              {activity.endTime && ` - ${formatDateTime(activity.endTime)}`}
                            </div>
                          )}
                          {activity.notes && <div>Notes: {activity.notes}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ padding: '10px', border: '1px solid #ffccc7', borderRadius: '5px', backgroundColor: '#fff2f0', color: '#cf1322' }}>
                    <p>Activity IDs: {meal.activity_ids.join(', ')}</p>
                    <div style={{ fontSize: '0.8em', color: '#888', fontStyle: 'italic', marginTop: '5px' }}>
                      (Details not available - IDs only)
                    </div>
                  </div>
                )}
              </>
            )}

            {meal.notes && (
              <>
                <h4>Notes</h4>
                <p>{meal.notes}</p>
              </>
            )}

            <div className="dash-history-modal-actions">
              <button
                className="dash-history-delete-button-modal"
                onClick={() => {
                  onClose();
                  setRecordToDelete(meal);
                }}
              >
                <FaTrash /> Delete Record
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const columns = React.useMemo(
    () => [
      {
        Header: 'Date/Time',
        accessor: 'formattedTimestamp',
      },
      {
        Header: 'Type',
        accessor: (row) => {
          switch(row.entryType) {
            case 'blood_sugar': return 'Blood Sugar';
            case 'activity': return 'Activity';
            case 'insulin': return 'Insulin';
            case 'meal': return row.mealType?.charAt(0).toUpperCase() + row.mealType?.slice(1).toLowerCase() || 'Meal';
            default: return row.mealType?.charAt(0).toUpperCase() + row.mealType?.slice(1).toLowerCase() || 'N/A';
          }
        }
      },
      {
        Header: 'Food Items',
        accessor: (row) => formatFoodItems(row.foodItems),
      },
      {
        Header: 'Activities',
        accessor: (row) => {
          if (row.entryType === 'activity') {
            if (row.level !== undefined) {
              return `Level ${row.level}`;
            } else if (row.activities && row.activities[0]?.level !== undefined) {
              return `Level ${row.activities[0].level}`;
            } else {
              return "Activity record";
            }
          }
          else if (row.activity_ids?.length) {
            return `${row.activity_ids.length} activities`;
          }
          return 'N/A';
        },
        Cell: ({ row }) => {
          const value = row.original.entryType === 'activity'
            ? (row.original.level !== undefined
               ? `Level ${row.original.level}`
               : row.original.activities && row.original.activities[0]?.level !== undefined
                 ? `Level ${row.original.activities[0].level}`
                 : "Activity record")
            : row.original.activity_ids?.length
              ? `${row.original.activity_ids.length} activities`
              : 'N/A';

          const isActivityLevel = row.original.entryType === 'activity' &&
                                (row.original.level !== undefined ||
                                 (row.original.activities && row.original.activities[0]?.level !== undefined));

          return (
            <span className={isActivityLevel ? 'dash-history-activity-level-badge' : ''}>
              {value}
            </span>
          );
        }
      },
      {
        Header: 'Blood Sugar',
        accessor: (row) => row.bloodSugar ? `${row.bloodSugar} mg/dL` : 'N/A',
        Cell: ({ row }) => {
          const value = row.original.bloodSugar;
          if (!value) return <span>N/A</span>;

          return (
            <span title={row.original.formattedBloodSugarTimestamp || 'No timestamp'}>
              {value} mg/dL
            </span>
          );
        }
      },
      {
        Header: 'Insulin (S/I)',
        accessor: (row) => `${row.suggestedInsulin || 'N/A'}/${row.intendedInsulin || 'N/A'}`
      },
      {
        Header: 'Source',
        accessor: (row) => row.imported_at ? 'Imported' : 'Direct',
        Cell: ({ value }) => (
          <span className={value === 'Imported' ? 'dash-history-imported-badge' : ''}>
            {value}
          </span>
        )
      }
    ],
    []
  );

  const handleRefresh = () => {
    fetchAllRecords();
  };

  const {
    getTableProps,
    getTableBodyProps,
    headerGroups,
    page,
    prepareRow,
    canPreviousPage,
    canNextPage,
    pageOptions,
    pageCount,
    gotoPage,
    nextPage,
    previousPage,
    setPageSize,
    state: { pageIndex, pageSize },
  } = useTable(
    {
      columns,
      data: filteredData,
      initialState: {
        pageIndex: 0,
        pageSize: pagination.limit,
        sortBy: [{ id: 'formattedTimestamp', desc: true }]
      }
    },
    useSortBy,
    usePagination
  );

  React.useEffect(() => {
    tableInstance.current = {
      gotoPage,
      nextPage,
      previousPage,
      setPageSize,
      pageCount,
      pageIndex
    };
  }, [gotoPage, nextPage, previousPage, setPageSize, pageCount, pageIndex]);

  if (loading && filteredData.length === 0) return <div>Loading meal history...</div>;

  return (
    <div className="dash-history-container">
      <h2>Meal History</h2>

      <div className="dash-history-timezone-info">
        Your timezone: {userTimeZone}
        <span className="dash-history-timezone-note"> (all times displayed in your local timezone)</span>
      </div>

      {message.text && (
        <div className={`dash-history-status-message dash-history-${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="dash-history-action-row">
        <div className="dash-history-filter-controls">
          <span className="dash-history-filter-label">Filter by: </span>
          <div className="dash-history-filter-buttons">
            <button
              className={`dash-history-filter-button ${activeFilter === 'all' ? 'dash-history-active' : ''}`}
              onClick={() => handleFilterChange('all')}
            >
              All Records
            </button>
            <button
              className={`dash-history-filter-button ${activeFilter === 'meal' ? 'dash-history-active' : ''}`}
              onClick={() => handleFilterChange('meal')}
            >
              Meals
            </button>
            <button
              className={`dash-history-filter-button ${activeFilter === 'blood_sugar' ? 'dash-history-active' : ''}`}
              onClick={() => handleFilterChange('blood_sugar')}
            >
              Blood Sugar
            </button>
            <button
              className={`dash-history-filter-button ${activeFilter === 'activity' ? 'dash-history-active' : ''}`}
              onClick={() => handleFilterChange('activity')}
            >
              Activity
            </button>
            <button
              className={`dash-history-filter-button ${activeFilter === 'insulin' ? 'dash-history-active' : ''}`}
              onClick={() => handleFilterChange('insulin')}
            >
              Insulin
            </button>
          </div>
        </div>

        <div className="dash-history-action-buttons">
          <button onClick={handleRefresh} className="dash-history-refresh-button" disabled={loading}>
            {loading ? "Loading..." : "Refresh Data"}
          </button>
        </div>
      </div>

      <div className="dash-history-records-info">
        <span>
          {loading
            ? "Loading records..."
            : `Showing ${filteredData.length} ${activeFilter !== 'all' ? activeFilter : ''} records`}
        </span>
        <span> (Total in database: {pagination.total})</span>
        {pagination.filteredTotal < pagination.total && activeFilter !== 'all' && (
          <span className="dash-history-filter-info">
            {` — ${pagination.filteredTotal} match your filter`}
          </span>
        )}
        {pagination.filteredTotal >= pagination.fetchLimit && (
          <span className="dash-history-warning-info">
            {` — showing first ${pagination.fetchLimit} records only`}
          </span>
        )}
      </div>

      {error && <div className="dash-history-error-message">{error}</div>}

      <div className="dash-history-table-container">
        <table {...getTableProps()} style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            {headerGroups.map(headerGroup => {
              const { key: headerGroupKey, ...headerGroupProps } = headerGroup.getHeaderGroupProps();
              return (
                <tr key={headerGroupKey} {...headerGroupProps}>
                  {headerGroup.headers.map(column => {
                    const { key, ...headerProps } = column.getHeaderProps(column.getSortByToggleProps());
                    return (
                      <th key={key} {...headerProps}>
                        {column.render('Header')}
                        <span>
                          {column.isSorted
                            ? column.isSortedDesc
                              ? ' 🔽'
                              : ' 🔼'
                            : ''}
                        </span>
                      </th>
                    );
                  })}
                  <th>Actions</th>
                </tr>
              );
            })}
          </thead>
          <tbody {...getTableBodyProps()}>
            {page.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} style={{ textAlign: 'center', padding: '20px' }}>
                  {loading ?
                    "Loading records..." :
                    `No records found ${activeFilter !== 'all' ? `for filter: ${activeFilter}` : ''}`
                  }
                </td>
              </tr>
            ) : (
              page.map(row => {
                prepareRow(row);
                const { key: rowKey, ...rowProps } = row.getRowProps();
                const entryTypeClass = `dash-history-entry-${row.original.entryType.replace('_', '-')}`;

                return (
                  <tr
                    key={rowKey}
                    {...rowProps}
                    className={`${row.original.imported_at ? 'dash-history-imported-row' : ''} ${entryTypeClass}`}
                  >
                    {row.cells.map(cell => {
                      const { key, ...cellProps } = cell.getCellProps();
                      return (
                        <td key={key} {...cellProps}>
                          {cell.render('Cell')}
                        </td>
                      );
                    })}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="dash-history-row-actions">
                        <button
                          onClick={() => setSelectedMeal(row.original)}
                          className="dash-history-details-button"
                        >
                          Details
                        </button>
                        <button
                          onClick={() => setRecordToDelete(row.original)}
                          className="dash-history-delete-button-small"
                          title={`Delete this ${getRecordTypeLabel(row.original.entryType)} record`}
                        >
                          <FaTrash />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="dash-history-pagination-controls">
        <div>
          <button onClick={() => gotoPage(0)} disabled={!canPreviousPage || loading}>
            {'<<'}
          </button>
          <button onClick={() => previousPage()} disabled={!canPreviousPage || loading}>
            {'<'}
          </button>
          <button onClick={() => nextPage()} disabled={!canNextPage || loading}>
            {'>'}
          </button>
          <button onClick={() => gotoPage(pageCount - 1)} disabled={!canNextPage || loading}>
            {'>>'}
          </button>
          <span>
            Page{' '}
            <strong>
              {pageIndex + 1} of {pageOptions.length || 1}
            </strong>
          </span>
        </div>
        <div className="dash-history-page-size-selector">
          <span>Show </span>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            disabled={loading}
          >
            {[10, 20, 50, 100].map(size => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <span> records per page</span>
        </div>
      </div>

      {selectedMeal && (
        <MealDetailsModal
          meal={selectedMeal}
          onClose={() => setSelectedMeal(null)}
        />
      )}

      {recordToDelete && (
        <ConfirmationDialog
          record={recordToDelete}
          onCancel={() => setRecordToDelete(null)}
          onConfirm={handleDeleteRecord}
          isDeleting={isDeleting}
        />
      )}
    </div>
  );
};

export default MealHistory;





import API_BASE_URL from '../config';
import React, { useState, useEffect } from 'react';

const DoctorMealHistory = ({ patientId }) => {
  const [meals, setMeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pagination, setPagination] = useState({
    total: 0,
    limit: 10,
    skip: 0
  });
  const [selectedMeal, setSelectedMeal] = useState(null);

  // Format date helper function
  const formatDateTime = (isoString) => {
    if (!isoString) return 'Invalid date';
    try {
      return new Date(isoString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Invalid date';
    }
  };

  // Calculate nutrition totals
  const calculateTotalNutrition = (foodItems) => {
    if (!Array.isArray(foodItems)) return { carbs: 0, protein: 0, fat: 0 };
    return foodItems.reduce((acc, item) => {
      if (!item?.details) return acc;
      const portion = item.portion?.amount || 1;
      return {
        carbs: acc.carbs + ((item.details.carbs || 0) * portion),
        protein: acc.protein + ((item.details.protein || 0) * portion),
        fat: acc.fat + ((item.details.fat || 0) * portion)
      };
    }, { carbs: 0, protein: 0, fat: 0 });
  };

  // Format food items for display
  const formatFoodItems = (foodItems) => {
    if (!Array.isArray(foodItems) || foodItems.length === 0) return "No items";
    const items = foodItems
      .map(item => {
        if (!item?.name) return null;
        const amount = item.portion?.amount || '';
        const unit = item.portion?.unit || '';
        return `${amount} ${unit} ${item.name}`.trim();
      })
      .filter(Boolean);
    
    if (items.length === 0) return "No items";
    if (items.length <= 2) return items.join(", ");
    return `${items[0]}, ${items[1]}, +${items.length - 2} more`;
  };

  // Fetch meals data
  useEffect(() => {
    const fetchMeals = async () => {
      if (!patientId) return;
      
      setLoading(true);
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(
          `${API_BASE_URL}/api/doctor/meal-history/${patientId}?limit=${pagination.limit}&skip=${pagination.skip}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch meal history');
        }

        const data = await response.json();
        setMeals(data.meals);
        setPagination(data.pagination);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchMeals();
  }, [patientId, pagination.limit, pagination.skip]);

  if (!patientId) {
    return <div className="p-4 text-gray-500">Select a patient to view meal history</div>;
  }

  if (loading && !meals.length) {
    return <div className="p-4">Loading meal history...</div>;
  }

  if (error) {
    return (
      <div className="p-4 text-red-600 bg-red-50 rounded">
        Error loading meal history: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold mb-4">Meal History</h3>
      
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date/Time</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Meal Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Food Items</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Blood Sugar</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Insulin</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {meals.map((meal, index) => {
              const nutrition = calculateTotalNutrition(meal.foodItems);
              return (
                <tr key={meal._id || index} 
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedMeal(meal)}>
                  <td className="px-6 py-4 whitespace-nowrap">{formatDateTime(meal.timestamp)}</td>
                  <td className="px-6 py-4">{meal.mealType}</td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-gray-900">{formatFoodItems(meal.foodItems)}</div>
                    <div className="text-xs text-gray-500">
                      C: {nutrition.carbs.toFixed(1)}g | P: {nutrition.protein.toFixed(1)}g | F: {nutrition.fat.toFixed(1)}g
                    </div>
                  </td>
                  <td className="px-6 py-4">{meal.bloodSugar || 'N/A'} mg/dL</td>
                  <td className="px-6 py-4">
                    S: {meal.suggestedInsulin || 'N/A'} / I: {meal.intendedInsulin || 'N/A'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 bg-white">
        <div className="flex justify-between w-full">
          <div className="text-sm text-gray-700">
            Showing {pagination.skip + 1} to {Math.min(pagination.skip + pagination.limit, pagination.total)} of{' '}
            {pagination.total} entries
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setPagination(prev => ({ ...prev, skip: Math.max(0, prev.skip - prev.limit) }))}
              disabled={pagination.skip === 0}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => setPagination(prev => ({ ...prev, skip: prev.skip + prev.limit }))}
              disabled={pagination.skip + pagination.limit >= pagination.total}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Meal Details Modal */}
      {selectedMeal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full m-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Meal Details</h3>
              <button
                onClick={() => setSelectedMeal(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              <p><strong>Date/Time:</strong> {formatDateTime(selectedMeal.timestamp)}</p>
              <p><strong>Meal Type:</strong> {selectedMeal.mealType}</p>
              <p><strong>Blood Sugar:</strong> {selectedMeal.bloodSugar || 'N/A'} mg/dL</p>
              <p><strong>Suggested Insulin:</strong> {selectedMeal.suggestedInsulin || 'N/A'} units</p>
              <p><strong>Intended Insulin:</strong> {selectedMeal.intendedInsulin || 'N/A'} units</p>
              
              <div>
                <h4 className="font-semibold mb-2">Food Items:</h4>
                <ul className="list-disc pl-5">
                  {selectedMeal.foodItems?.map((item, index) => (
                    <li key={index}>
                      {item.portion?.amount} {item.portion?.unit} {item.name}
                    </li>
                  ))}
                </ul>
              </div>
              
              {selectedMeal.notes && (
                <div>
                  <h4 className="font-semibold mb-2">Notes:</h4>
                  <p>{selectedMeal.notes}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DoctorMealHistory;





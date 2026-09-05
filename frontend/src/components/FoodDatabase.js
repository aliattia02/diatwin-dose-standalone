import API_BASE_URL from '../config';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { FaSearch, FaHeart, FaPlus } from 'react-icons/fa';
import './Charts/dashboard-components.css';
import { VOLUME_MEASUREMENTS, WEIGHT_MEASUREMENTS } from '../constants';

const FoodDatabase = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [categories, setCategories] = useState({});
  const [customFoods, setCustomFoods] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [message, setMessage] = useState('');
  const [isAddingCustomFood, setIsAddingCustomFood] = useState(false);
  const [newCustomFood, setNewCustomFood] = useState({
    name: '',
    serving_size_amount: '',
    serving_size_unit: 'g',
    measurement_type: 'weight',
    carbs: '',
    protein: '',
    fat: '',
    description: '',
    absorption_type: 'medium'
  });

  useEffect(() => {
    fetchCategories();
    fetchCustomFoods();
    fetchFavorites();
  }, []);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        setMessage('');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const fetchCategories = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/categories`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCategories(response.data.categories);
    } catch (error) {
      setMessage('Error loading food categories');
      console.error('Error:', error);
    }
  };

  const fetchCustomFoods = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/custom`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCustomFoods(response.data);
    } catch (error) {
      setMessage('Error loading custom foods');
      console.error('Error:', error);
    }
  };

  const fetchFavorites = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/favorite`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setFavorites(response.data);
    } catch (error) {
      setMessage('Error loading favorites');
      console.error('Error:', error);
    }
  };

  const handleSearch = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/search`, {
        params: {
          q: searchQuery,
          category: selectedCategory || undefined
        },
        headers: { Authorization: `Bearer ${token}` }
      });
      setSearchResults(response.data);
    } catch (error) {
      setMessage('Error searching foods');
      console.error('Error:', error);
    }
  };

  const handleAddCustomFood = async () => {
    try {
      const token = localStorage.getItem('token');

      // Determine measurement type and get standard values
      let servingAmount = parseFloat(newCustomFood.serving_size_amount) || 1;
      let standardizedServingSize = {};

      if (newCustomFood.measurement_type === 'volume') {
        const volumeMeasurement = VOLUME_MEASUREMENTS[newCustomFood.serving_size_unit];
        standardizedServingSize = {
          amount: servingAmount,
          unit: newCustomFood.serving_size_unit,
          w_amount: servingAmount * (volumeMeasurement ? volumeMeasurement.ml : 1),
          w_unit: 'ml'
        };
      } else {
        const weightMeasurement = WEIGHT_MEASUREMENTS[newCustomFood.serving_size_unit];
        standardizedServingSize = {
          amount: servingAmount,
          unit: newCustomFood.serving_size_unit,
          w_amount: servingAmount * (weightMeasurement ? weightMeasurement.grams : 1),
          w_unit: 'g'
        };
      }

      const customFoodData = {
        name: newCustomFood.name,
        serving_size: standardizedServingSize,
        carbs: parseFloat(newCustomFood.carbs),
        protein: parseFloat(newCustomFood.protein),
        fat: parseFloat(newCustomFood.fat),
        description: newCustomFood.description || '',
        absorption_type: newCustomFood.absorption_type || 'medium'
      };

      await axios.post(`${API_BASE_URL}/api/food/custom`, customFoodData, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      setMessage('Custom food added successfully');
      setIsAddingCustomFood(false);
      setNewCustomFood({
        name: '',
        serving_size_amount: '',
        serving_size_unit: 'g',
        measurement_type: 'weight',
        carbs: '',
        protein: '',
        fat: '',
        description: '',
        absorption_type: 'medium'
      });
      fetchCustomFoods();
    } catch (error) {
      setMessage('Error adding custom food');
      console.error('Error:', error);
    }
  };

  const handleAddToFavorites = async (foodName) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(`${API_BASE_URL}/api/food/favorite`,
        { food_name: foodName },
        { headers: { Authorization: `Bearer ${token}` }}
      );
      setMessage('Added to favorites');
      fetchFavorites();
    } catch (error) {
      setMessage('Error adding to favorites');
      console.error('Error:', error);
    }
  };

  const formatServingSize = (servingSize) => {
    try {
      if (!servingSize) return '';
      if (typeof servingSize === 'string') return servingSize;
      if (typeof servingSize === 'object') {
        return `${servingSize.amount} ${servingSize.unit}`;
      }
      return String(servingSize);
    } catch (error) {
      console.error('Error formatting serving size:', error);
      return 'N/A';
    }
  };

  return (
    <div className="dash-food-database">
      <h2 className="dash-food-page-title">Food Database</h2>

      {/* Search Section */}
      <div className="dash-food-section">
        <div className="dash-food-search-container">
          <input
            type="text"
            placeholder="Search foods..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            className="dash-food-search-input"
          />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="dash-food-category-select"
          >
            <option value="">All Categories</option>
            {Object.keys(categories).map((category) => (
              <option key={category} value={category}>
                {category.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
              </option>
            ))}
          </select>
          <button onClick={handleSearch} className="dash-food-button dash-food-button-primary">
            <FaSearch /> Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="dash-food-grid-container">
            {searchResults.map((food, index) => (
              <div key={index} className="dash-food-card">
                <div className="dash-food-card-header">
                  <h3 className="dash-food-title">{food.name}</h3>
                  <button
                    onClick={() => handleAddToFavorites(food.name)}
                    className="dash-food-favorite-button"
                    title="Add to favorites"
                  >
                    <FaHeart />
                  </button>
                </div>
                <p className="dash-food-category">Category: {food.category}</p>
                <div className="dash-food-details">
                  <p>Carbs: {food.details.carbs}g</p>
                  <p>Protein: {food.details.protein}g</p>
                  <p>Fat: {food.details.fat}g</p>
                  <p>Absorption Type: {food.details.absorption_type || 'Unknown'}</p>
                  {food.details.serving_size && (
                    <p>Serving: {formatServingSize(food.details.serving_size)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom Foods Section */}
      <div className="dash-food-section">
        <div className="dash-food-section-header">
          <h3 className="dash-food-section-title">Custom Foods</h3>
          <button
            onClick={() => setIsAddingCustomFood(!isAddingCustomFood)}
            className="dash-food-button dash-food-button-success"
          >
            <FaPlus /> {isAddingCustomFood ? 'Cancel' : 'Add Custom Food'}
          </button>
        </div>

        {isAddingCustomFood && (
          <div className="dash-food-custom-form">
            <div className="dash-food-form-grid">
              <input
                type="text"
                placeholder="Food name"
                value={newCustomFood.name}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, name: e.target.value })}
                className="dash-food-form-input"
              />
              <select
                value={newCustomFood.measurement_type}
                onChange={(e) => {
                  const newMeasurementType = e.target.value;
                  setNewCustomFood(prev => ({
                    ...prev,
                    measurement_type: newMeasurementType,
                    serving_size_unit: newMeasurementType === 'volume' ? 'cup' : 'g'
                  }));
                }}
                className="dash-food-form-input"
              >
                <option value="weight">Weight</option>
                <option value="volume">Volume</option>
              </select>
              <input
                type="number"
                placeholder="Serving size"
                value={newCustomFood.serving_size_amount}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, serving_size_amount: e.target.value })}
                className="dash-food-form-input"
                step="0.1"
              />
              <select
                value={newCustomFood.serving_size_unit}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, serving_size_unit: e.target.value })}
                className="dash-food-form-input"
              >
                {newCustomFood.measurement_type === 'volume'
                  ? Object.keys(VOLUME_MEASUREMENTS).map(unit => (
                      <option key={unit} value={unit}>
                        {VOLUME_MEASUREMENTS[unit].display_name}
                      </option>
                    ))
                  : Object.keys(WEIGHT_MEASUREMENTS).map(unit => (
                      <option key={unit} value={unit}>
                        {WEIGHT_MEASUREMENTS[unit].display_name}
                      </option>
                    ))
                }
              </select>
              <input
                type="number"
                placeholder="Carbs (g)"
                value={newCustomFood.carbs}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, carbs: e.target.value })}
                className="dash-food-form-input"
                step="0.1"
              />
              <input
                type="number"
                placeholder="Protein (g)"
                value={newCustomFood.protein}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, protein: e.target.value })}
                className="dash-food-form-input"
                step="0.1"
              />
              <input
                type="number"
                placeholder="Fat (g)"
                value={newCustomFood.fat}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, fat: e.target.value })}
                className="dash-food-form-input"
                step="0.1"
              />
              <select
                value={newCustomFood.absorption_type}
                onChange={(e) => setNewCustomFood({ ...newCustomFood, absorption_type: e.target.value })}
                className="dash-food-form-input"
              >
                <option value="very_fast">Very Fast</option>
                <option value="fast">Fast</option>
                <option value="medium">Medium</option>
                <option value="slow">Slow</option>
                <option value="very_slow">Very Slow</option>
              </select>
            </div>
            <textarea
              placeholder="Description (optional)"
              value={newCustomFood.description}
              onChange={(e) => setNewCustomFood({ ...newCustomFood, description: e.target.value })}
              className="dash-food-form-textarea"
              rows="3"
            />
            <button
              onClick={handleAddCustomFood}
              className="dash-food-button dash-food-button-primary"
              disabled={!newCustomFood.name || !newCustomFood.carbs}
            >
              Save Custom Food
            </button>
          </div>
        )}

        <div className="dash-food-grid-container">
          {customFoods.map((food, index) => (
            <div key={index} className="dash-food-card">
              <h4 className="dash-food-title">{food.name}</h4>
              <p className="dash-food-category">Serving: {formatServingSize(food.serving_size)}</p>
              <div className="dash-food-details">
                <p>Carbs: {food.carbs}g</p>
                <p>Protein: {food.protein}g</p>
                <p>Fat: {food.fat}g</p>
                <p>Absorption: {food.absorption_type || 'medium'}</p>
                {food.description && (
                  <p style={{ fontSize: '0.85em', fontStyle: 'italic', marginTop: '8px' }}>
                    {food.description}
                  </p>
                )}
              </div>
            </div>
          ))}
          {customFoods.length === 0 && !isAddingCustomFood && (
            <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#666' }}>
              No custom foods yet. Click "Add Custom Food" to create one.
            </p>
          )}
        </div>
      </div>

      {/* Favorites Section */}
      <div className="dash-food-section">
        <h3 className="dash-food-section-title">Favorite Foods</h3>
        <div className="dash-food-grid-container">
          {favorites.map((food, index) => (
            <div key={index} className="dash-food-card">
              <h4 className="dash-food-title">{food.name}</h4>
              <p className="dash-food-category">Category: {food.category}</p>
              <div className="dash-food-details">
                <p>Carbs: {food.details.carbs}g</p>
                <p>Protein: {food.details.protein}g</p>
                <p>Fat: {food.details.fat}g</p>
                <p>Absorption Type: {food.details.absorption_type || 'Unknown'}</p>
                {food.details.serving_size && (
                  <p>Serving: {formatServingSize(food.details.serving_size)}</p>
                )}
              </div>
            </div>
          ))}
          {favorites.length === 0 && (
            <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#666' }}>
              No favorite foods yet. Add foods to favorites by clicking the heart icon.
            </p>
          )}
        </div>
      </div>

      {message && (
        <div className="dash-food-toast-message">
          {message}
        </div>
      )}
    </div>
  );
};

export default FoodDatabase;





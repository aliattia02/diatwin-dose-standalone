import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { FaPlus, FaMinus, FaHeart, FaSearch, FaStar } from 'react-icons/fa';
import { calculateNutrients } from './EnhancedPatientConstantsCalc';
import { MEASUREMENT_SYSTEMS, VOLUME_MEASUREMENTS, WEIGHT_MEASUREMENTS } from '../constants';
import './Charts/input-components.css'; // Updated import

// Helper function to prevent event propagation
const preventEventPropagation = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

const FoodItem = ({ item, updatePortion, removeItem, onPortionChange }) => {
  const [amount, setAmount] = useState(() => {
    return item.portion?.activeMeasurement === MEASUREMENT_SYSTEMS.VOLUME
      ? item.portion?.amount || 1
      : item.portion?.w_amount || item.details?.serving_size?.w_amount || 1;
  });

  const [unit, setUnit] = useState(() => {
    return item.portion?.activeMeasurement === MEASUREMENT_SYSTEMS.VOLUME
      ? item.portion?.unit || 'ml'
      : item.portion?.w_unit || item.details?.serving_size?.w_unit || 'g';
  });

  const [measurementSystem, setMeasurementSystem] = useState(
    item.portion?.activeMeasurement || MEASUREMENT_SYSTEMS.WEIGHT
  );

  const [nutrients, setNutrients] = useState({ carbs: 0, protein: 0, fat: 0 });

  const getMeasurementData = useCallback((system) => {
    return system === MEASUREMENT_SYSTEMS.VOLUME ? VOLUME_MEASUREMENTS : WEIGHT_MEASUREMENTS;
  }, []);

  useEffect(() => {
    const newNutrients = calculateNutrients(item);
    setNutrients({
      carbs: parseFloat(newNutrients.carbs).toFixed(1),
      protein: parseFloat(newNutrients.protein).toFixed(1),
      fat: parseFloat(newNutrients.fat).toFixed(1),
      absorptionType: newNutrients.absorptionType
    });
  }, [item]);

  useEffect(() => {
    const newPortion = {
      amount: measurementSystem === MEASUREMENT_SYSTEMS.VOLUME ? amount : null,
      unit: measurementSystem === MEASUREMENT_SYSTEMS.VOLUME ? unit : null,
      w_amount: measurementSystem === MEASUREMENT_SYSTEMS.WEIGHT ? amount : null,
      w_unit: measurementSystem === MEASUREMENT_SYSTEMS.WEIGHT ? unit : null,
      activeMeasurement: measurementSystem
    };

    const hasChanged = JSON.stringify(newPortion) !== JSON.stringify(item.portion);

    if (hasChanged) {
      updatePortion(item.id, newPortion);
      if (onPortionChange) {
        onPortionChange(item.id, newPortion);
      }
    }
  }, [amount, unit, measurementSystem, item.id, updatePortion, onPortionChange]);

  const handleMeasurementSystemChange = (e, newSystem) => {
    preventEventPropagation(e);
    if (newSystem === measurementSystem) return;

    let newAmount = amount;
    let newUnit = newSystem === MEASUREMENT_SYSTEMS.VOLUME ? 'ml' : 'g';

    if (measurementSystem === MEASUREMENT_SYSTEMS.VOLUME && newSystem === MEASUREMENT_SYSTEMS.WEIGHT) {
      const currentMl = amount * (VOLUME_MEASUREMENTS[unit]?.ml || 1);
      newAmount = currentMl;
    } else if (measurementSystem === MEASUREMENT_SYSTEMS.WEIGHT && newSystem === MEASUREMENT_SYSTEMS.VOLUME) {
      const currentGrams = amount * (WEIGHT_MEASUREMENTS[unit]?.grams || 1);
      newAmount = currentGrams;
    }

    setAmount(newAmount);
    setUnit(newUnit);
    setMeasurementSystem(newSystem);
  };

  const handleAmountChange = (e, newAmount) => {
    if (e) {
      preventEventPropagation(e);
    }
    const validAmount = Math.max(0.5, Number(newAmount) || 0.5);
    setAmount(validAmount);
  };

  const handleUnitChange = (e) => {
    preventEventPropagation(e);
    const newUnit = e.target.value;
    const measurements = getMeasurementData(measurementSystem);
    const oldUnitValue = measurementSystem === MEASUREMENT_SYSTEMS.VOLUME
      ? measurements[unit]?.ml || 1
      : measurements[unit]?.grams || 1;
    const newUnitValue = measurementSystem === MEASUREMENT_SYSTEMS.VOLUME
      ? measurements[newUnit]?.ml || 1
      : measurements[newUnit]?.grams || 1;

    const convertedAmount = (amount * oldUnitValue) / newUnitValue;
    setAmount(parseFloat(convertedAmount.toFixed(2)));
    setUnit(newUnit);
  };

  const getAvailableUnits = () => {
    const measurements = getMeasurementData(measurementSystem);
    return Object.entries(measurements).map(([key, value]) => ({
      value: key,
      label: value.display_name
    }));
  };

  const handleRemoveItem = (e) => {
    preventEventPropagation(e);
    removeItem(item.id);
  };

  return (
    <div className="food-item">
      <div className="food-item-header">
        <h4 className="food-item-title">{item.name}</h4>
        <button
          onClick={handleRemoveItem}
          className="food-button-remove"
        >
          <FaMinus />
        </button>
      </div>

      <div className="food-measurement-toggle">
        <div className="food-toggle-buttons">
          <button
            onClick={(e) => handleMeasurementSystemChange(e, MEASUREMENT_SYSTEMS.WEIGHT)}
            className={`food-toggle-button ${
              measurementSystem === MEASUREMENT_SYSTEMS.WEIGHT ? 'food-toggle-active' : ''
            }`}
          >
            Weight
          </button>
          <button
            onClick={(e) => handleMeasurementSystemChange(e, MEASUREMENT_SYSTEMS.VOLUME)}
            className={`food-toggle-button ${
              measurementSystem === MEASUREMENT_SYSTEMS.VOLUME ? 'food-toggle-active' : ''
            }`}
          >
            Volume
          </button>
        </div>
      </div>

      <div className="food-portion-control">
        <div className="food-amount-control">
          <button
            onClick={(e) => handleAmountChange(e, amount - 0.5)}
            className="food-control-button"
          >
            <FaMinus className="food-button-icon" />
          </button>

          <input
            type="number"
            value={amount}
            onChange={(e) => handleAmountChange(e, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                preventEventPropagation(e);
              }
            }}
            step="0.5"
            min="0.5"
            className="food-portion-input"
          />

          <button
            onClick={(e) => handleAmountChange(e, amount + 0.5)}
            className="food-control-button"
          >
            <FaPlus className="food-button-icon" />
          </button>
        </div>

        <select
          value={unit}
          onChange={handleUnitChange}
          onClick={preventEventPropagation}
          className="food-unit-select"
        >
          {getAvailableUnits().map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="food-nutrients-display">
        <div className="food-nutrient-item">
          <span className="food-nutrient-label">Carbs</span>
          <span className="food-nutrient-value">{nutrients.carbs}g</span>
        </div>
        <div className="food-nutrient-item">
          <span className="food-nutrient-label">Protein</span>
          <span className="food-nutrient-value">{nutrients.protein}g</span>
        </div>
        <div className="food-nutrient-item">
          <span className="food-nutrient-label">Fat</span>
          <span className="food-nutrient-value">{nutrients.fat}g</span>
        </div>
        <div className="food-nutrient-item">
          <span className="food-nutrient-label">Absorption</span>
          <span className={`food-nutrient-value food-absorption-badge food-absorption-${nutrients.absorptionType}`}>
            {nutrients.absorptionType?.replace('_', ' ') || 'medium'}
          </span>
        </div>
      </div>
    </div>
  );
};

const FoodSearch = ({ onFoodSelect }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [categories, setCategories] = useState({});
  const [favorites, setFavorites] = useState([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const [message, setMessage] = useState('');
  const [portionTypes, setPortionTypes] = useState({
    volume: ['ml', 'cup', 'tablespoon', 'teaspoon'],
    weight: ['g', 'kg'],
    standard_portions: {}
  });

  useEffect(() => {
    fetchCategories();
    fetchFavorites();
    fetchPortionTypes();
  }, []);

  const fetchPortionTypes = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/measurements`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data) {
        setPortionTypes(response.data);
      }
    } catch (error) {
      console.error('Error loading portion types:', error);
      setMessage('Failed to load measurement types');
    }
  };

  const fetchCategories = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/api/food/categories`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCategories(response.data.categories);
    } catch (error) {
      console.error('Error loading categories:', error);
      setMessage('Failed to load categories');
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
      console.error('Error loading favorites:', error);
      setMessage('Failed to load favorites');
    }
  };

  const searchFoods = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const queryParams = new URLSearchParams({
        q: searchQuery,
        ...(selectedCategory && { category: selectedCategory })
      });
      const response = await axios.get(`${API_BASE_URL}/api/food/search?${queryParams}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSearchResults(response.data);
    } catch (error) {
      console.error('Error searching foods:', error);
      setMessage('Search failed. Please try again.');
    }
  }, [searchQuery, selectedCategory]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (searchQuery || selectedCategory) {
        searchFoods();
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [searchQuery, selectedCategory, searchFoods]);

  const handleAddToFavorites = async (e, food) => {
    preventEventPropagation(e);
    try {
      const token = localStorage.getItem('token');
      await axios.post(`${API_BASE_URL}/api/food/favorite`,
        { food_name: food.name },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setMessage('Added to favorites');
      fetchFavorites();
    } catch (error) {
      setMessage('Error adding to favorites');
    }

    setTimeout(() => setMessage(''), 3000);
  };

  const handleFoodSelect = (e, food) => {
    preventEventPropagation(e);
    onFoodSelect({ ...food, portionTypes });
  };

  const handleSearchInputChange = (e) => {
    preventEventPropagation(e);
    setSearchQuery(e.target.value);
  };

  const handleCategoryChange = (e) => {
    preventEventPropagation(e);
    setSelectedCategory(e.target.value);
  };

  const handleToggleFavorites = (e, showFavs) => {
    preventEventPropagation(e);
    setShowFavorites(showFavs);
  };

  return (
    <div className="food-search">
      <div className="food-search-buttons">
        <button
          className={`food-tab-button ${!showFavorites ? 'food-tab-active' : ''}`}
          onClick={(e) => handleToggleFavorites(e, false)}
        >
          <FaSearch className="food-button-icon" /> Search Foods
        </button>
        <button
          className={`food-tab-button ${showFavorites ? 'food-tab-active' : ''}`}
          onClick={(e) => handleToggleFavorites(e, true)}
        >
          <FaStar className="food-button-icon" /> Favorites
        </button>
      </div>

      {!showFavorites ? (
        <div className="food-search-container">
          <div className="food-search-controls">
            <input
              type="text"
              className="food-search-input"
              value={searchQuery}
              onChange={handleSearchInputChange}
              onClick={preventEventPropagation}
              onKeyDown={(e) => {
                if (e.key === 'Enter') preventEventPropagation(e);
              }}
              placeholder="Search for food..."
              aria-label="Search foods"
            />
            <select
              className="food-category-select"
              value={selectedCategory}
              onChange={handleCategoryChange}
              onClick={preventEventPropagation}
              aria-label="Select category"
            >
              <option value="">All Categories</option>
              {Object.keys(categories).map((category) => (
                <option key={category} value={category}>
                  {category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </option>
              ))}
            </select>
          </div>

          <div className="food-search-results">
            {searchResults.map((food) => (
              <div key={food.id || food.name} className="food-card-simple">
                <div className="food-card-header">
                  <h4 className="food-card-title">{food.name}</h4>
                  <div className="food-card-actions">
                    <button
                      className="food-favorite-button"
                      onClick={(e) => handleAddToFavorites(e, food)}
                      aria-label="Add to favorites"
                    >
                      <FaHeart />
                    </button>
                    <button
                      className="food-add-button"
                      onClick={(e) => handleFoodSelect(e, food)}
                      aria-label="Add food"
                    >
                      <FaPlus /> Add
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="food-favorites-grid">
          {favorites.map((food) => (
            <div key={food.id || food.name} className="food-card-simple">
              <div className="food-card-header">
                <h4 className="food-card-title">{food.name}</h4>
                <button
                  className="food-add-button"
                  onClick={(e) => handleFoodSelect(e, food)}
                  aria-label="Add food"
                >
                  <FaPlus /> Add
                </button>
              </div>
            </div>
          ))}
          {favorites.length === 0 && (
            <p className="food-empty-message">No favorites yet</p>
          )}
        </div>
      )}
      {message && <p className="food-message">{message}</p>}
    </div>
  );
};

const FoodSection = ({ selectedFoods, onFoodSelect, onUpdatePortion, onRemoveFood, onPortionChange }) => {
  const handlePreventPropagation = (e) => {
    preventEventPropagation(e);
  };

  return (
    <div className="food-section" onClick={handlePreventPropagation}>
      <FoodSearch onFoodSelect={onFoodSelect} />

      {selectedFoods.length > 0 && (
        <div className="food-selected-foods">
          <h3 className="food-section-title">Selected Foods</h3>
          {selectedFoods.map((food) => (
            <FoodItem
              key={food.id}
              item={food}
              updatePortion={onUpdatePortion}
              removeItem={onRemoveFood}
              onPortionChange={onPortionChange}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default FoodSection;





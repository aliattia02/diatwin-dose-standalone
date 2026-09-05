import axios from 'axios';
import moment from 'moment';

// Common utility for data import functionality
export const DataImportHelper = {
  /**
   * Process uploaded file and return parsed data
   * @param {File} file - The uploaded file
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} - Parsed data and file format
   */
  processFile: async (file, options = {}) => {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No file selected'));
        return;
      }

      const supportedFormats = options.supportedFormats || ['csv', 'json'];
      const extension = file.name.split('.').pop().toLowerCase();

      if (!supportedFormats.includes(extension)) {
        reject(new Error(`Unsupported file format: .${extension}. Please use: ${supportedFormats.join(', ')}`));
        return;
      }

      const reader = new FileReader();

      reader.onload = (event) => {
        try {
          if (extension === 'json') {
            const jsonData = JSON.parse(event.target.result);
            resolve({
              data: jsonData,
              preview: jsonData.slice(0, 5),
              format: 'json'
            });
          } else if (extension === 'csv') {
            const lines = event.target.result.split('\n');
            const headers = lines[0].split(',').map(h => h.trim());
            const data = [];

            for (let i = 1; i < lines.length; i++) {
              if (!lines[i].trim()) continue;

              const values = lines[i].split(',').map((v, idx) => {
                // Handle quoted values that might contain commas
                if (v.startsWith('"') && !v.endsWith('"')) {
                  let j = idx + 1;
                  let combinedValue = v;

                  while (j < values.length) {
                    combinedValue += ',' + values[j];
                    if (values[j].endsWith('"')) {
                      // Remove quotes
                      values.splice(idx + 1, j - idx);
                      return combinedValue.slice(1, -1);
                    }
                    j++;
                  }
                }
                return v.trim().replace(/^"(.*)"$/, '$1'); // Remove surrounding quotes
              });

              const row = {};
              headers.forEach((header, index) => {
                if (index < values.length) {
                  row[header] = values[index];
                }
              });
              data.push(row);
            }

            resolve({
              data,
              preview: data.slice(0, 5),
              format: 'csv',
              headers
            });
          }
        } catch (error) {
          reject(new Error(`Error parsing file: ${error.message}`));
        }
      };

      reader.onerror = () => {
        reject(new Error('Error reading file'));
      };

      if (extension === 'json' || extension === 'csv') {
        reader.readAsText(file);
      } else {
        reject(new Error(`Unsupported file format: ${extension}`));
      }
    });
  },

  /**
   * Map CSV headers to required fields
   * @param {Array} headers - CSV headers
   * @param {Object} fieldMappings - Required field mappings
   * @returns {Object} - Mapped fields
   */
  mapFields: (headers, fieldMappings) => {
    const mappedFields = {};

    headers.forEach(header => {
      const matchingField = Object.keys(fieldMappings).find(
        fieldKey => fieldMappings[fieldKey].toLowerCase() === header.toLowerCase()
      );

      if (matchingField) {
        mappedFields[matchingField] = header;
      }
    });

    return mappedFields;
  },

  /**
   * Submit import data to API
   * @param {String} endpoint - API endpoint
   * @param {String} importType - Type of import
   * @param {Array} data - Data to import
   * @returns {Promise<Object>} - Import result
   */
  submitImport: async (endpoint, importType, data) => {
  try {
    const token = localStorage.getItem('token');

    if (!token) {
      throw new Error('Authentication token not found');
    }

    // Add metadata about the import
    const metadataEnhancedData = {
      data: data,
      importMeta: {
        importedAt: new Date().toISOString(),
        systemVersion: '1.0',
        importType: importType
      }
    };

    const response = await axios.post(
      endpoint,
      metadataEnhancedData,
      {
        headers: {
          'Authorization': `Bearer ${token}`, // This ensures patient-specific data
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.error || error.message);
  }
},

  // Common utility functions for each data type
  transformers: {
    meals: (data) => {
      return data.map(item => {
        // Parse and normalize timestamps to ISO format
        let timestamp = moment().toISOString();
        try {
          timestamp = moment(item.timestamp).toISOString();
        } catch (e) {}

        // Parse food items if they're in string format (CSV import)
        let foodItems = item.foodItems;
        if (typeof foodItems === 'string') {
          try {
            foodItems = JSON.parse(foodItems);
          } catch (e) {
            // If not valid JSON, try to parse as comma-separated list
            foodItems = foodItems.split(',').map(food => ({
              name: food.trim(),
              portion: { amount: 1, unit: 'serving' },
              details: { carbs: 0, protein: 0, fat: 0 }
            }));
          }
        }

        // Create proper meal document structure
        return {
          timestamp,
          mealType: item.mealType || 'snack',
          foodItems: foodItems || [],
          nutrition: {
            calories: DataImportHelper.calculateCalories(item),
            carbs: parseFloat(item.carbs) || 0,
            protein: parseFloat(item.protein) || 0,
            fat: parseFloat(item.fat) || 0,
            absorption_factor: 1.0
          },
          bloodSugar: item.bloodSugar ? parseFloat(item.bloodSugar) : null,
          bloodSugarTimestamp: timestamp,
          intendedInsulin: item.insulinDose ? parseFloat(item.insulinDose) : null,
          intendedInsulinType: item.insulinType || 'regular_insulin',
          notes: item.notes || '',
          importedRecord: true
        };
      });
    },

    bloodSugar: (data) => {
      return data.map(item => {
        // Parse and normalize timestamps to ISO format
        let timestamp, readingTime;
        try {
          timestamp = moment(item.timestamp).toISOString();
          readingTime = item.readingTime ? moment(item.readingTime).toISOString() : timestamp;
        } catch (e) {
          const now = moment();
          timestamp = now.toISOString();
          readingTime = timestamp;
        }

        // Convert mmol/L to mg/dL if needed
        let bloodSugar = parseFloat(item.bloodSugar);
        const unit = item.unit && item.unit.toLowerCase();

        if (!isNaN(bloodSugar) && unit === 'mmol/l') {
          bloodSugar = Math.round(bloodSugar * 18); // Convert to mg/dL
        }

        return {
          timestamp,
          bloodSugarTimestamp: readingTime,
          bloodSugar,
          bloodSugarSource: item.source || 'imported',
          notes: item.notes || '',
          mealType: 'blood_sugar_only',
          recordingType: 'standalone_blood_sugar'
        };
      });
    },

    activities: (data) => {
      return data.map(item => {
        // Parse and normalize timestamps to ISO format
        let startTime, endTime;
        try {
          startTime = moment(item.startTime).toISOString();

          if (item.endTime) {
            endTime = moment(item.endTime).toISOString();
          } else if (item.duration) {
            // Parse duration in format HH:MM
            const durationParts = item.duration.split(':');
            let durationMinutes = 0;

            if (durationParts.length === 2) {
              durationMinutes = (parseInt(durationParts[0], 10) * 60) + parseInt(durationParts[1], 10);
            } else {
              durationMinutes = parseInt(durationParts[0], 10) * 60;
            }

            endTime = moment(startTime).add(durationMinutes, 'minutes').toISOString();
          } else {
            // Default to 1 hour duration
            endTime = moment(startTime).add(1, 'hour').toISOString();
          }
        } catch (e) {
          const now = moment();
          startTime = now.toISOString();
          endTime = moment(now).add(1, 'hour').toISOString();
        }

        // Determine activity level
        let level = parseInt(item.level, 10);
        if (isNaN(level)) {
          level = 0; // Default to normal activity
        }

        // Ensure level is within valid range (-2 to 2)
        level = Math.min(Math.max(level, -2), 2);

        const activityType = item.type === 'expected' ? 'expected' : 'completed';

        return {
          [activityType === 'expected' ? 'expectedActivities' : 'completedActivities']: [{
            level,
            startTime,
            endTime,
            duration: item.duration || DataImportHelper.calculateDuration(startTime, endTime),
            [activityType === 'expected' ? 'expectedTime' : 'completedTime']: startTime,
            type: activityType,
            notes: item.notes || ''
          }],
          notes: item.notes || ''
        };
      });
    },

    insulin: (data) => {
      return data.map(item => {
        // Parse and normalize timestamps to ISO format
        let timestamp, administrationTime;
        try {
          timestamp = moment(item.timestamp).toISOString();
          administrationTime = item.administrationTime ?
            moment(item.administrationTime).toISOString() : timestamp;
        } catch (e) {
          const now = moment();
          timestamp = now.toISOString();
          administrationTime = timestamp;
        }

        // Normalize insulin type name
        let insulinType = item.medication || 'regular_insulin';
        if (!insulinType.includes('_')) {
          // Convert spaces to underscores and lowercase
          insulinType = insulinType.toLowerCase().replace(/\s+/g, '_');
        }

        return {
          mealType: item.mealType || 'insulin_only',
          recordingType: 'insulin',
          timestamp,
          foodItems: [], // Empty for insulin-only records
          activities: [],
          bloodSugar: item.bloodSugar ? parseFloat(item.bloodSugar) : null,
          bloodSugarSource: 'imported',
          intendedInsulin: parseFloat(item.dose),
          intendedInsulinType: insulinType,
          notes: item.notes || '',
          medicationLog: {
            is_insulin: true,
            dose: parseFloat(item.dose),
            medication: insulinType,
            scheduled_time: administrationTime,
            taken_at: administrationTime,
            notes: item.notes || '',
            status: 'taken'
          }
        };
      });
    }
  },

  // Helper functions
  calculateCalories: (item) => {
    const carbs = parseFloat(item.carbs) || 0;
    const protein = parseFloat(item.protein) || 0;
    const fat = parseFloat(item.fat) || 0;

    return Math.round((carbs * 4) + (protein * 4) + (fat * 9));
  },

  calculateDuration: (startTime, endTime) => {
    const start = moment(startTime);
    const end = moment(endTime);
    const diffMinutes = end.diff(start, 'minutes');

    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
};

export default DataImportHelper;




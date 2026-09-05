# Backend T1D Model Enhancement - API Changes Documentation

## Overview
This document describes the API changes made to support the T1D model distinction between:
- **Absorbed** (PAST→PRESENT): Already in bloodstream, affecting current BG
- **Active/On Board** (PRESENT→FUTURE): Still digesting/active, will affect future BG

## 1. MOB Endpoint Changes

### Endpoint: `GET /api/meal-on-board`

### Previous Response
```json
{
  "total_active_carbs": 25.5,
  "expected_bg_impact": 102.0,
  "contributions": [...],
  "active_meal_count": 2,
  "calculation_time": "2024-01-22T10:30:00",
  "calculation_timezone": "UTC"
}
```

### New Response (with backward compatibility)
```json
{
  "total_active_carbs": 25.5,           // MOB (PRESENT→FUTURE) - unchanged
  "total_absorbed_carbs": 18.3,         // NEW: Already absorbed (PAST→PRESENT)
  "current_bg_elevation": 73.2,         // NEW: BG impact from absorbed carbs
  "pending_bg_rise": 102.0,             // NEW: Future BG impact from MOB
  "expected_bg_impact": 102.0,          // Legacy field (equals pending_bg_rise)
  "contributions": [...],                // unchanged
  "active_meal_count": 2,               // unchanged
  "calculation_time": "2024-01-22T10:30:00",
  "calculation_timezone": "UTC"
}
```

### Calculations
- `total_absorbed_carbs` = Sum of `absorbed_carbs` from all contributions
- `current_bg_elevation` = `total_absorbed_carbs` × `carb_to_bg_factor`
- `pending_bg_rise` = `total_active_carbs` × `carb_to_bg_factor`
- `expected_bg_impact` = `pending_bg_rise` (for backward compatibility)

---

## 2. IOB Endpoint Changes

### Endpoint: Internal function `calculate_stacked_insulin_effect()`
Called by `GET /api/active-insulin`

### Previous Response
```json
{
  "total_active_insulin": 2.5,
  "calculation_time": "2024-01-22T10:30:00",
  "calculation_timezone": "UTC",
  "active_doses": 2,
  "insulin_contributions": [
    {
      "dose_id": "abc123",
      "medication": "humalog",
      "initial_dose": 5.0,
      "taken_at": "2024-01-22T08:30:00",
      "hours_since_dose": 2.0,
      "activity_percent": 50.0,
      "active_units": 2.5
    }
  ],
  "bg_impact": -125.0
}
```

### New Response (with backward compatibility)
```json
{
  "total_active_insulin": 2.5,           // IOB - unchanged
  "total_absorbed_insulin": 2.5,         // NEW: Already absorbed
  "current_bg_reduction": 125.0,         // NEW: Current BG reduction from absorbed
  "pending_bg_reduction": 125.0,         // NEW: Future BG reduction from IOB
  "calculation_time": "2024-01-22T10:30:00",
  "calculation_timezone": "UTC",
  "active_doses": 2,
  "insulin_contributions": [
    {
      "dose_id": "abc123",
      "medication": "humalog",
      "initial_dose": 5.0,
      "taken_at": "2024-01-22T08:30:00",
      "hours_since_dose": 2.0,
      "activity_percent": 50.0,
      "active_units": 2.5,
      "absorbed_units": 2.5              // NEW: Already absorbed units
    }
  ],
  "bg_impact": -125.0                     // Legacy field (negative value)
}
```

### Calculations
- `absorbed_units` = `initial_dose` - `active_units` (for each dose)
- `total_absorbed_insulin` = Sum of `absorbed_units` from all doses
- `current_bg_reduction` = `total_absorbed_insulin` × `correction_factor`
- `pending_bg_reduction` = `total_active_insulin` × `correction_factor`
- `bg_impact` = `-1` × `pending_bg_reduction` (legacy, negative for reduction)

---

## 3. Blood Sugar POST Endpoint Changes

### Endpoint: `POST /api/blood-sugar`

### Previous Request/Response
```json
// Request
{
  "bloodSugar": 180,
  "bloodSugarTimestamp": "2024-01-22T10:30:00Z",
  "notes": "After breakfast",
  "bloodSugarSource": "fingerstick"
}

// Response - stored document
{
  "user_id": "user123",
  "bloodSugar": 180,
  "status": "normal",
  "target": 120,
  "timestamp": "2024-01-22T10:30:00",
  "bloodSugarTimestamp": "2024-01-22T10:30:00",
  "notes": "After breakfast",
  "source": "fingerstick"
}
```

### New Response (with baseline calculation)
```json
// Request - unchanged
{
  "bloodSugar": 180,
  "bloodSugarTimestamp": "2024-01-22T10:30:00Z",
  "notes": "After breakfast",
  "bloodSugarSource": "fingerstick"
}

// Response - stored document with baseline
{
  "user_id": "user123",
  "bloodSugar": 180,
  "status": "normal",
  "target": 120,
  "timestamp": "2024-01-22T10:30:00",
  "bloodSugarTimestamp": "2024-01-22T10:30:00",
  "notes": "After breakfast",
  "source": "fingerstick",
  "baseline_calculation": {              // NEW: Baseline metadata
    "baseline": 132,                     // Calculated baseline BG
    "net_effect": 48.0,                  // Net effect on current BG
    "meal_impact": 73.2,                 // BG elevation from absorbed carbs
    "insulin_impact": 25.2,              // BG reduction from absorbed insulin
    "confidence": "high",                // Confidence level
    "calculation_time": "2024-01-22T10:30:00"
  }
}
```

### Calculations
1. Get recent meals (last 12 hours)
2. Calculate absorbed carbs from each meal
3. `meal_impact` = `total_absorbed_carbs` × `carb_to_bg_factor`
4. Get IOB data to extract `current_bg_reduction`
5. `insulin_impact` = `current_bg_reduction`
6. `net_effect` = `meal_impact` - `insulin_impact`
7. `baseline` = `blood_sugar` - `net_effect`

---

## Patient Constants Used

Both endpoints use patient-specific constants from the Constants class:

- `carb_to_bg_factor`: How much 1g of carbs raises BG (default: 4.0 mg/dL)
- `correction_factor`: How much 1 unit of insulin lowers BG (default: 50 mg/dL)

---

## Backward Compatibility

All changes are **fully backward compatible**:

1. **MOB Endpoint**: 
   - Existing fields unchanged
   - `expected_bg_impact` maintained (equals `pending_bg_rise`)
   - New fields added only

2. **IOB Endpoint**:
   - Existing fields unchanged
   - `bg_impact` maintained as negative value
   - New fields added to contributions

3. **Blood Sugar Endpoint**:
   - Request format unchanged
   - Existing document fields unchanged
   - `baseline_calculation` is an additional optional field

---

## Example Use Cases

### Frontend Mobile App Usage

```javascript
// Example: Get MOB data
const mobResponse = await fetch('/api/meal-on-board');
const mobData = await mobResponse.json();

// NEW: Separate absorbed vs active carbs
const absorbedCarbs = mobData.total_absorbed_carbs;  // Already affecting BG
const activeCarbs = mobData.total_active_carbs;      // Will affect BG

// Calculate baseline from current BG reading
const currentBG = 180;
const mealElevation = mobData.current_bg_elevation;  // From absorbed carbs
const insulinReduction = iobData.current_bg_reduction; // From absorbed insulin
const baseline = currentBG - (mealElevation - insulinReduction);

console.log(`Current BG: ${currentBG}`);
console.log(`Meal elevated by: ${mealElevation}`);
console.log(`Insulin lowered by: ${insulinReduction}`);
console.log(`Calculated baseline: ${baseline}`);
```

### Doctor Dashboard Usage

```javascript
// Example: Analyze patient's blood sugar reading
const reading = await getBloodSugarReading(readingId);

if (reading.baseline_calculation) {
  console.log('Baseline BG:', reading.baseline_calculation.baseline);
  console.log('Net effect:', reading.baseline_calculation.net_effect);
  console.log('From meals:', reading.baseline_calculation.meal_impact);
  console.log('From insulin:', reading.baseline_calculation.insulin_impact);
  
  // Assess if meal/insulin dosing was appropriate
  const wasHighDueToMeal = reading.baseline_calculation.meal_impact > 50;
  const needsMoreInsulin = reading.baseline_calculation.insulin_impact < reading.baseline_calculation.meal_impact;
}
```

---

## Testing

Run the test suite to verify all changes:

```bash
cd backend
python3 test_absorbed_active_endpoints.py
```

All 6 test categories should pass:
- ✓ MOB response structure
- ✓ IOB response structure
- ✓ Blood sugar response structure
- ✓ Calculation logic
- ✓ Backward compatibility
- ✓ Patient constants usage

---

## Implementation Notes

1. **Order of Implementation**: IOB changes must be completed before Blood Sugar changes, as the latter depends on `current_bg_reduction` from IOB.

2. **Error Handling**: All baseline calculations in Blood Sugar endpoint are wrapped in try-catch blocks to ensure readings are always saved even if calculations fail.

3. **Timezone Handling**: All calculations use timezone-naive timestamps for consistency.

4. **Performance**: Baseline calculation adds minimal overhead (~2 database queries) to Blood Sugar POST endpoint.

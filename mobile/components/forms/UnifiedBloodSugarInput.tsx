/**
 * Unified Blood Sugar Input
 * Location: mobile/components/forms/UnifiedBloodSugarInput.tsx
 *
 * Main Component: UnifiedBloodSugarInput
 * Description: Blood sugar input component with UTC timestamp handling,
 *              properly handles UTC storage and local display
 *
 * Features:
 * - Blood sugar value input with validation
 * - Unit conversion (mg/dL ↔ mmol/L)
 * - Status indicators (low/normal/high)
 * - UTC timestamp management via UnifiedTimePicker
 * - Reference ranges display
 * - Real-time validation and feedback
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity } from 'react-native';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Utils
import { GLUCOSE_LIMITS } from '@/utils/validation';
import { TimeManager } from '@/utils/time';

// Hooks
import { usePatientConstants } from '@/hooks/usePatientConstants';

// Components
import UnifiedTimePicker, { type TimeMode } from './UnifiedTimePicker';

// Types
export type GlucoseUnit = 'mg/dL' | 'mmol/L';

export interface BloodSugarData {
  value: string;
  timestamp: string; // ISO string in UTC
  unit: GlucoseUnit;
  status?: 'low' | 'normal' | 'high' | null;
}

interface UnifiedBloodSugarInputProps {
  onChange: (data: BloodSugarData) => void;
  initialValue?: string;
  initialUnit?: GlucoseUnit;
  initialTimestamp?: Date | string;
  initialMode?: TimeMode;
  standalone?: boolean;
  disabled?: boolean;
  showTimestampSelector?: boolean;
  showUnitSelector?: boolean;
  showStatusIndicator?: boolean;
  showReferenceRanges?: boolean;
}

const UnifiedBloodSugarInput: React.FC<UnifiedBloodSugarInputProps> = ({
  onChange,
  initialValue = '',
  initialUnit = 'mg/dL',
  initialTimestamp,
  initialMode = 'now',
  standalone = false,
  disabled = false,
  showTimestampSelector = true,
  showUnitSelector = true,
  showStatusIndicator = true,
  showReferenceRanges = true,
}) => {
  const [bloodSugar, setBloodSugar] = useState(initialValue);
  const [unit, setUnit] = useState<GlucoseUnit>(initialUnit);
  const [timestampUTC, setTimestampUTC] = useState<string>(
    initialTimestamp ? new Date(initialTimestamp).toISOString() : new Date().toISOString()
  );
  const [timestampMode, setTimestampMode] = useState<TimeMode>(initialMode);
  const [status, setStatus] = useState<'low' | 'normal' | 'high' | null>(null);

  // I-11: Derive thresholds from patient constants to match backend logic
  // (backend uses target_glucose * 0.7 for low, * 1.3 for high)
  const { constants: patientConsts } = usePatientConstants();
  const targetGlucose = patientConsts?.target_glucose ?? 100; // mg/dL
  const LOW_THRESHOLD_MG_DL  = targetGlucose * 0.7;
  const HIGH_THRESHOLD_MG_DL = targetGlucose * 1.3;
  // mmol/L thresholds for display comparison only (divide by 18)
  const LOW_THRESHOLD_MMOL_L  = LOW_THRESHOLD_MG_DL  / 18;
  const HIGH_THRESHOLD_MMOL_L = HIGH_THRESHOLD_MG_DL / 18;

  // Use ref for debouncing
  const debounceTimeout = useRef<NodeJS.Timeout | null>(null);
  const isInitialMount = useRef(true);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
    };
  }, []);

  // Update status when blood sugar value changes
  useEffect(() => {
    if (!bloodSugar) {
      setStatus(null);
      return;
    }

    const value = parseFloat(bloodSugar);
    if (isNaN(value)) {
      setStatus(null);
      return;
    }

    if (unit === 'mg/dL') {
      if (value < LOW_THRESHOLD_MG_DL) {
        setStatus('low');
      } else if (value > HIGH_THRESHOLD_MG_DL) {
        setStatus('high');
      } else {
        setStatus('normal');
      }
    } else {
      if (value < LOW_THRESHOLD_MMOL_L) {
        setStatus('low');
      } else if (value > HIGH_THRESHOLD_MMOL_L) {
        setStatus('high');
      } else {
        setStatus('normal');
      }
    }
  }, [bloodSugar, unit]);

  // Trigger callback with debouncing (ONLY when value changes)
  useEffect(() => {
    // Skip on initial mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // Clear any existing timeout
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }

    // Only trigger callback if value is valid
    const numericValue = parseFloat(bloodSugar);
    if (bloodSugar && !isNaN(numericValue)) {
      // Debounce by 800ms - only trigger after user stops typing
      debounceTimeout.current = setTimeout(() => {
        console.log('[UnifiedBloodSugarInput] Triggering callback:', bloodSugar, timestampUTC);
        onChange({
          value: bloodSugar,
          timestamp: timestampUTC,
          unit,
          status,
        });
      }, 800);
    } else if (!bloodSugar) {
      // If field is cleared, notify immediately
      onChange({
        value: '',
        timestamp: timestampUTC,
        unit,
        status: null,
      });
    }
  }, [bloodSugar]);

  // Separate effect for unit changes (immediate, no debounce)
  useEffect(() => {
    if (isInitialMount.current) return;

    if (bloodSugar && !isNaN(parseFloat(bloodSugar))) {
      onChange({
        value: bloodSugar,
        timestamp: timestampUTC,
        unit,
        status,
      });
    }
  }, [unit]);

  // Separate effect for timestamp changes from UnifiedTimePicker
  useEffect(() => {
    if (isInitialMount.current) return;

    if (bloodSugar && !isNaN(parseFloat(bloodSugar))) {
      onChange({
        value: bloodSugar,
        timestamp: timestampUTC,
        unit,
        status,
      });
    }
  }, [timestampUTC]);

  const handleBloodSugarChange = (value: string) => {
    // Allow only numbers and decimal point
    const sanitized = value.replace(/[^0-9.]/g, '');

    // Prevent multiple decimal points
    const parts = sanitized.split('.');
    if (parts.length > 2) return;

    setBloodSugar(sanitized);
  };

  const handleUnitToggle = () => {
    const newUnit: GlucoseUnit = unit === 'mg/dL' ? 'mmol/L' : 'mg/dL';

    // Convert value if exists
    if (bloodSugar) {
      const value = parseFloat(bloodSugar);
      if (!isNaN(value)) {
        let convertedValue: string;
        if (newUnit === 'mmol/L') {
          // mg/dL to mmol/L: divide by 18
          convertedValue = (value / 18).toFixed(1);
        } else {
          // mmol/L to mg/dL: multiply by 18
          convertedValue = (value * 18).toFixed(0);
        }
        setBloodSugar(convertedValue);
      }
    }
    setUnit(newUnit);
  };

  const handleTimeChange = (utcIsoString: string) => {
    console.log('[UnifiedBloodSugarInput] Time changed to:', utcIsoString);
    setTimestampUTC(utcIsoString);
  };

  const handleModeChange = (newMode: TimeMode) => {
    setTimestampMode(newMode);
  };

  const getStatusColor = () => {
    switch (status) {
      case 'low':
        return colors.danger;
      case 'high':
        return colors.warning;
      case 'normal':
        return colors.success;
      default:
        return colors.text.secondary;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'low':
        return 'Below target range';
      case 'high':
        return 'Above target range';
      case 'normal':
        return 'Within target range';
      default:
        return 'Enter blood sugar reading';
    }
  };

  return (
    <View style={[styles.container, !standalone && styles.containerEmbedded]}>
      {standalone && <Text style={styles.label}>Blood Sugar Level</Text>}

      {/* Input Row */}
      <View style={styles.inputRow}>
        <TextInput
          style={[
            styles.input,
            status && showStatusIndicator && { borderColor: getStatusColor() },
          ]}
          value={bloodSugar}
          onChangeText={handleBloodSugarChange}
          placeholder={`Enter reading (${unit})`}
          keyboardType="decimal-pad"
          editable={!disabled}
          placeholderTextColor={colors.text.secondary}
        />

        {showUnitSelector && (
          <TouchableOpacity style={styles.unitButton} onPress={handleUnitToggle} disabled={disabled}>
            <Text style={styles.unitButtonText}>{unit}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Status Indicator */}
      {status && showStatusIndicator && (
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor() + '20' }]}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
          <Text style={[styles.statusText, { color: getStatusColor() }]}>{getStatusText()}</Text>
        </View>
      )}

      {/* Unified Time Picker - Integrated with TimeManager */}
      {showTimestampSelector && (
        <UnifiedTimePicker
          value={timestampUTC}
          onChange={handleTimeChange}
          mode={timestampMode}
          onModeChange={handleModeChange}
          disabled={disabled}
          label="Reading Time"
          displayFormat="datetime"
        />
      )}


    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  containerEmbedded: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    padding: 0,
    marginBottom: 0,
  },
  label: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
  },
  unitButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 80,
  },
  unitButtonText: {
    color: colors.text.inverse,
    fontWeight: '600',
    fontSize: 14,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    marginBottom: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  statusText: {
    ...typography.small,
    fontWeight: '500',
  },

});

export default UnifiedBloodSugarInput;
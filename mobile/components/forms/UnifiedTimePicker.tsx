/**
 * Unified Time Picker
 * Location: mobile/components/forms/UnifiedTimePicker.tsx
 *
 * Main Component: UnifiedTimePicker
 * Description: Unified time picker with "now" mode and custom time selection,
 *              properly handles UTC storage and local display
 *
 * Features:
 * - "Now" mode: Live updating current time display
 * - "Custom" mode: User-selectable date/time
 * - UTC timestamp management
 * - Platform-specific pickers (iOS/Android/Web)
 * - Timezone display
 * - Multiple display formats (time/datetime/relative)
 *
 * Critical fixes:
 * - "now" mode no longer triggers onChange every second
 * - Only calls onChange when user manually switches mode or picks time
 * - Internal state updates don't propagate upstream continuously
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Modal } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Utils
import { TimeManager } from '@/utils/time';

export type TimeMode = 'now' | 'custom';

export interface UnifiedTimePickerProps {
  /** Current time value - can be Date, ISO string, or local datetime string */
  value: Date | string | null | undefined;
  /** Callback when time changes - receives ISO string in UTC */
  onChange: (isoString: string) => void;
  /** Mode: 'now' (live updating) or 'custom' (user selects) */
  mode?: TimeMode;
  /** Callback when mode changes */
  onModeChange?: (mode: TimeMode) => void;
  /** Disable input */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Show Now/Custom mode selector */
  showModeSelector?: boolean;
  /** Display format for the time */
  displayFormat?: 'time' | 'datetime' | 'relative';
}

const UnifiedTimePicker: React.FC<UnifiedTimePickerProps> = ({
  value,
  onChange,
  mode = 'now',
  onModeChange,
  disabled = false,
  label = 'Time',
  showModeSelector = true,
  displayFormat = 'datetime',
}) => {
  // Parse a value into a Date object.
  // Guards against null / undefined / invalid-Date inputs so the Android
  // DateTimePicker (which requires a genuine Date instance) never receives NaN.
  //
  // IMPORTANT: Try the native Date constructor FIRST — it handles UTC ISO 8601
  // strings (e.g. "2026-03-26T18:39:00.000Z") reliably on all platforms.
  // TimeManager.parseTimestamp may not accept raw UTC ISO strings and could
  // throw, which previously caused the catch block to silently fall back to
  // new Date() (current wall-clock time), discarding the snapped meal time.
  const parseValue = (val: Date | string | null | undefined): Date => {
    if (val instanceof Date) {
      return isNaN(val.getTime()) ? new Date() : val;
    }
    if (!val) return new Date();
    // Native constructor handles ISO 8601 / UTC strings correctly on all JS runtimes.
    const native = new Date(val as string);
    if (!isNaN(native.getTime())) return native;
    // Fallback: let TimeManager handle non-standard local datetime strings.
    try {
      const parsed = TimeManager.parseTimestamp(val as string);
      return parsed instanceof Date && !isNaN(parsed.getTime()) ? parsed : new Date();
    } catch {
      return new Date();
    }
  };

  // Guarantee a Date passed to <DateTimePicker value={}> is always valid.
  // Android throws an Invariant Violation if value is an Invalid Date.
  const safeDate = (d: Date): Date =>
    d instanceof Date && !isNaN(d.getTime()) ? d : new Date();

  const [currentValue, setCurrentValue] = useState<Date>(parseValue(value));
  const [showPicker, setShowPicker] = useState(false);
  const [tempTime, setTempTime] = useState<Date>(parseValue(value));

  // Track if we've done initial setup
  const initialSetupDone = useRef(false);
  // Track last value we EMITTED to parent — used to prevent re-emit feedback loops.
  const lastEmittedValue = useRef<string>('');
  // Track last value we RECEIVED from parent — used to detect genuine external changes.
  // Kept separate from lastEmittedValue because programmatic parent changes (e.g.
  // handleSaveInsulin snap) must always update the display, even when the new value
  // happens to match something we emitted earlier in the session.
  const lastReceivedValue = useRef<string>('');
  // Track previous mode so we can detect a 'now' → 'custom' transition.
  // On a mode transition we ALWAYS sync currentValue from the incoming prop,
  // bypassing the lastReceivedValue guard — this is safe because a mode change
  // driven by the parent (e.g. handleSaveInsulin snap) is by definition a new
  // authoritative value, not an echo-back of something we emitted.
  const prevModeRef = useRef<TimeMode>(mode);

  // Only emit onChange when value actually changes
  const emitChange = (newDate: Date) => {
    const utcString = newDate.toISOString();
    if (utcString !== lastEmittedValue.current) {
      lastEmittedValue.current = utcString;
      // Mirror into lastReceivedValue so the sync effect doesn't re-process
      // the same value when the parent reflects it back as a prop update.
      lastReceivedValue.current = utcString;
      onChange(utcString);
    }
  };

  // Auto-update display when in "now" mode - BUT DON'T EMIT CHANGES
  useEffect(() => {
    if (mode === 'now' && !disabled) {
      // Update display immediately
      const now = new Date();
      setCurrentValue(now);

      // CRITICAL: Only emit onChange on initial mount in "now" mode
      if (!initialSetupDone.current) {
        initialSetupDone.current = true;
        emitChange(now);
      }

      // Update display every minute (not every second!)
      const interval = setInterval(() => {
        const now = new Date();
        setCurrentValue(now);
        // DO NOT call onChange here - parent doesn't need to know about display updates
      }, 60000); // Update every minute instead of every second

      return () => clearInterval(interval);
    }
  }, [mode, disabled]);

  // Sync display when the parent pushes a new value OR switches to custom mode.
  //
  // Two cases must update currentValue:
  //   1. Value genuinely changed (incoming !== lastReceivedValue) — normal prop update.
  //   2. Mode just transitioned to 'custom' — parent-driven snap (e.g. handleSaveInsulin)
  //      sets both value AND mode together; always honour the new value in this case
  //      regardless of lastReceivedValue so the display never shows a stale time.
  useEffect(() => {
    const modeTransitionedToCustom = prevModeRef.current !== 'custom' && mode === 'custom';
    prevModeRef.current = mode;

    if (mode === 'custom') {
      const incoming = typeof value === 'string' ? value
                     : value instanceof Date ? value.toISOString() : '';
      if (incoming && (modeTransitionedToCustom || incoming !== lastReceivedValue.current)) {
        lastReceivedValue.current = incoming;
        const newValue = parseValue(value);
        setCurrentValue(newValue);
        setTempTime(newValue);
      }
    }
  }, [value, mode]);

  const handleModeChange = (newMode: TimeMode) => {
    if (newMode === 'now') {
      const now = new Date();
      setCurrentValue(now);
      emitChange(now);
    } else {
      // 'custom': emit the CURRENT displayed time so parent syncs immediately.
      // Do NOT reset currentValue to 'now' — preserve what the user sees.
      emitChange(currentValue);
    }
    onModeChange?.(newMode);
  };

  // iOS / web: modal-based picker handlers
  const handleTimeChange = (event: any, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowPicker(false);
      return;
    }
    if (selectedDate) {
      setTempTime(selectedDate);
    }
  };

  const handleConfirm = () => {
    setCurrentValue(tempTime);
    emitChange(tempTime);
    setShowPicker(false);
  };

  const handleCancel = () => {
    setTempTime(currentValue);
    setShowPicker(false);
  };

  // Android: imperative API — avoids the "dismiss of undefined" unmount crash
  // that occurs when the component is unmounted while the native dialog is open.
  // Defaults to time-only so users just adjust the time for today.
  // Android: two-step chained picker — time first, then date automatically.
  // No extra UI needed; one tap opens both native dialogs in sequence.
  // Uses the imperative API to avoid the "dismiss of undefined" unmount crash.
  const openAndroidPicker = () => {
    if (disabled) return;
    const base = safeDate(currentValue);

    // Step 1 — time
    DateTimePickerAndroid.open({
      value: base,
      mode: 'time',
      is24Hour: true,
      onChange: (timeEvent, selectedTime) => {
        if (timeEvent.type === 'dismissed' || !selectedTime) return;

        // Step 2 — date (opens immediately after time is confirmed)
        DateTimePickerAndroid.open({
          value: base,
          mode: 'date',
          onChange: (dateEvent, selectedDate) => {
            if (dateEvent.type === 'dismissed' || !selectedDate) {
              // User dismissed date — use today with the chosen time
              const today = new Date();
              today.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
              setCurrentValue(today);
              emitChange(today);
              return;
            }
            // Merge chosen time into chosen date
            const merged = new Date(selectedDate);
            merged.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
            setCurrentValue(merged);
            emitChange(merged);
          },
        });
      },
    });
  };

  const openPicker = () => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      openAndroidPicker();
    } else {
      setTempTime(currentValue);
      setShowPicker(true);
    }
  };

  // Format display based on displayFormat prop
  const getDisplayText = (): string => {
    switch (displayFormat) {
      case 'time':
        return TimeManager.formatTime(currentValue);
      case 'relative':
        return TimeManager.formatRelativeTime(currentValue);
      case 'datetime':
      default:
        return TimeManager.formatDate(currentValue, TimeManager.formats.DATETIME_DISPLAY);
    }
  };

  const getTimezoneDisplay = (): string => {
    return TimeManager.getUserTimeZone();
  };

  // Time-only for "Now" mode inside the pill
  const getTimeOnlyText = (): string => TimeManager.formatTime(currentValue);

  return (
    <View style={styles.container}>
      {label && <Text style={styles.label}>{label}</Text>}

      {/* Fused compact pill */}
      {showModeSelector && (
        <View style={styles.modeSelector}>

          {/* Now side — shows time-only when active */}
          <TouchableOpacity
            style={[styles.modeButton, mode === 'now' && styles.modeButtonActive]}
            onPress={() => handleModeChange('now')}
            disabled={disabled}
          >
            <View style={styles.modeButtonInner}>
              <Text style={[styles.modeButtonText, mode === 'now' && styles.modeButtonTextActive]}>
                Now
              </Text>
              {mode === 'now' && (
                <>
                  <View style={styles.liveDot} />
                  <Text style={styles.modeTimeText}>{getTimeOnlyText()}</Text>
                </>
              )}
            </View>
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.modeDivider} />

          {/* Custom side — tapping opens picker when already active */}
          <TouchableOpacity
            style={[styles.modeButton, mode === 'custom' && styles.modeButtonActive]}
            onPress={mode === 'custom' ? openPicker : () => handleModeChange('custom')}
            disabled={disabled}
          >
            <View style={styles.modeButtonInner}>
              <Text style={[styles.modeButtonText, mode === 'custom' && styles.modeButtonTextActive]}>
                Custom
              </Text>
              {mode === 'custom' && (
                <Text style={styles.modeTimeText}>{getDisplayText()}</Text>
              )}
            </View>
          </TouchableOpacity>

        </View>
      )}

      {/* Timezone — only in custom mode, compact */}
      {mode === 'custom' && (
        <Text style={styles.timezoneHint}>{getTimezoneDisplay()}</Text>
      )}

      {/* Time Picker - Platform Specific Rendering */}
      {Platform.OS === 'web' ? (
        /* Web: Use Modal with time input */
        <Modal
          visible={showPicker}
          transparent
          animationType="fade"
          onRequestClose={handleCancel}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Select Time</Text>

              <input
                type="datetime-local"
                value={TimeManager.formatDateTimeLocal(tempTime)}
                onChange={(e) => {
                  const newDate = new Date(e.target.value);
                  if (TimeManager.isValidTimestamp(e.target.value)) {
                    setTempTime(newDate);
                  }
                }}
                style={{
                  fontSize: 16,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #e0e0e0',
                  marginVertical: 20,
                  width: '100%',
                }}
              />

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.cancelButton]}
                  onPress={handleCancel}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, styles.confirmButton]}
                  onPress={handleConfirm}
                >
                  <Text style={styles.confirmButtonText}>Confirm</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      ) : Platform.OS === 'ios' ? (
        /* iOS: Use Modal with native picker */
        showPicker && (
          <Modal
            visible={showPicker}
            transparent
            animationType="slide"
            onRequestClose={handleCancel}
          >
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                <View style={styles.pickerHeader}>
                  <TouchableOpacity onPress={handleCancel}>
                    <Text style={styles.pickerHeaderButton}>Cancel</Text>
                  </TouchableOpacity>
                  <Text style={styles.pickerHeaderTitle}>Select Time</Text>
                  <TouchableOpacity onPress={handleConfirm}>
                    <Text style={[styles.pickerHeaderButton, styles.confirmText]}>Done</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={safeDate(tempTime)}
                  mode="datetime"
                  display="spinner"
                  onChange={handleTimeChange}
                  locale="en_GB"
                  style={styles.iosPicker}
                />
              </View>
            </View>
          </Modal>
        )
      ) : (
        /* Android: picker opened imperatively via openAndroidPicker() — no JSX needed.
           The inline <DateTimePicker> approach causes a "dismiss of undefined" crash
           when the component unmounts while the native dialog is still open. */
        null
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.sm,
  },
  label: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
    fontWeight: '500',
  },
  modeSelector: {
    flexDirection: 'row',
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeButton: {
    flex: 1,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  modeButtonActive: {
    backgroundColor: colors.primary,
  },
  modeButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'nowrap',
  },
  modeButtonText: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: colors.text.inverse,
    fontWeight: '600',
  },
  modeTimeText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '500',
    opacity: 0.9,
  },
  modeDivider: {
    width: 1,
    backgroundColor: colors.border,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  timezoneHint: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 3,
    fontStyle: 'italic',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    minWidth: 300,
    maxWidth: '90%',
  },
  modalTitle: {
    ...typography.h3,
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  modalButton: {
    flex: 1,
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  confirmButton: {
    backgroundColor: colors.primary,
  },
  confirmButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerHeaderButton: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  pickerHeaderTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  confirmText: {
    color: colors.primary,
  },
  iosPicker: {
    height: 200,
  },
});

export default UnifiedTimePicker;
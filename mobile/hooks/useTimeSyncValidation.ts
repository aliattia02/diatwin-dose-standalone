/**
 * Time Synchronization Validation Hook
 * Location: mobile/hooks/useTimeSyncValidation.ts
 * 
 * CREATED FOR: Fix #4 - Time sync validation
 * 
 * This hook validates that client-side time calculations match
 * backend calculations to detect timezone synchronization issues.
 * 
 * Usage:
 * ```typescript
 * import { useTimeSyncValidation } from '@/hooks/useTimeSyncValidation';
 * 
 * function MyComponent() {
 *   const [mobData, setMobData] = useState<MealOnBoardResponse | null>(null);
 *   const [iobData, setIobData] = useState<ActiveInsulinResponse | null>(null);
 *   
 *   // Add validation
 *   useTimeSyncValidation(mobData, iobData);
 *   
 *   // ... rest of component
 * }
 * ```
 */

import { useEffect } from 'react';
import type { MealOnBoardResponse } from '@/services/api/mob';
import type { ActiveInsulinResponse } from '@/types/api';

interface TimeSyncIssue {
  type: 'MOB' | 'IOB';
  itemType: string;
  timestamp: string;
  backendHours: number;
  clientHours: number;
  discrepancyMinutes: number;
}

export const useTimeSyncValidation = (
  mobData: MealOnBoardResponse | null,
  iobData: ActiveInsulinResponse | null
) => {
  useEffect(() => {
    if (!mobData && !iobData) return;

    const now = new Date();
    const issues: TimeSyncIssue[] = [];

    // Validate MOB meal times
    mobData?.contributions?.forEach((contrib) => {
      const mealTimeUTC = new Date(contrib.meal_time);
      const backendHours = contrib.hours_elapsed;
      const clientHours = (now.getTime() - mealTimeUTC.getTime()) / (1000 * 60 * 60);
      const discrepancy = Math.abs(backendHours - clientHours);

      if (discrepancy > 0.1) { // >6 minutes discrepancy
        issues.push({
          type: 'MOB',
          itemType: contrib.meal_type,
          timestamp: mealTimeUTC.toISOString(),
          backendHours,
          clientHours,
          discrepancyMinutes: discrepancy * 60,
        });

        console.error('🚨 TIME SYNC ISSUE DETECTED - MOB 🚨');
        console.error(`Meal: ${contrib.meal_type} at ${mealTimeUTC.toISOString()}`);
        console.error(`Backend: ${backendHours.toFixed(2)}h | Client: ${clientHours.toFixed(2)}h`);
        console.error(`Discrepancy: ${(discrepancy * 60).toFixed(1)} minutes`);
      }
    });

    // Validate IOB dose times
    iobData?.insulin_contributions?.forEach((contrib) => {
      const doseTimeUTC = new Date(contrib.taken_at);
      const backendHours = contrib.hours_since_dose;
      const clientHours = (now.getTime() - doseTimeUTC.getTime()) / (1000 * 60 * 60);
      const discrepancy = Math.abs(backendHours - clientHours);

      if (discrepancy > 0.1) { // >6 minutes discrepancy
        issues.push({
          type: 'IOB',
          itemType: contrib.medication,
          timestamp: doseTimeUTC.toISOString(),
          backendHours,
          clientHours,
          discrepancyMinutes: discrepancy * 60,
        });

        console.error('🚨 TIME SYNC ISSUE DETECTED - IOB 🚨');
        console.error(`Dose: ${contrib.medication} at ${doseTimeUTC.toISOString()}`);
        console.error(`Backend: ${backendHours.toFixed(2)}h | Client: ${clientHours.toFixed(2)}h`);
        console.error(`Discrepancy: ${(discrepancy * 60).toFixed(1)} minutes`);
      }
    });

    // Summary warning if issues detected
    if (issues.length > 0) {
      console.error('========================================');
      console.error('⚠️  TIME SYNCHRONIZATION ISSUES DETECTED');
      console.error(`   Found ${issues.length} time discrepanc${issues.length === 1 ? 'y' : 'ies'}`);
      console.error('   This could affect insulin dosing safety!');
      console.error('');
      console.error('📊 Issue Summary:');
      
      const mobIssues = issues.filter(i => i.type === 'MOB');
      const iobIssues = issues.filter(i => i.type === 'IOB');
      
      if (mobIssues.length > 0) {
        console.error(`   MOB: ${mobIssues.length} meal${mobIssues.length === 1 ? '' : 's'}`);
      }
      if (iobIssues.length > 0) {
        console.error(`   IOB: ${iobIssues.length} dose${iobIssues.length === 1 ? '' : 's'}`);
      }
      
      console.error('');
      console.error('🔧 Troubleshooting:');
      console.error('   1. Check device timezone settings');
      console.error('   2. Verify TimeManager.parseTimestamp() implementation');
      console.error('   3. Check for double timezone offset application');
      console.error('   4. Review backend UTC time generation');
      console.error('========================================');

      // Log detailed issue table
      console.table(issues.map(issue => ({
        Type: issue.type,
        Item: issue.itemType,
        'Backend (h)': issue.backendHours.toFixed(2),
        'Client (h)': issue.clientHours.toFixed(2),
        'Diff (min)': issue.discrepancyMinutes.toFixed(1),
      })));
    }
  }, [mobData, iobData]);
};

/**
 * Manual validation function for testing
 */
export const validateTimestamp = (
  timestamp: string,
  expectedHoursAgo: number
): { valid: boolean; discrepancyMinutes: number } => {
  const eventTime = new Date(timestamp);
  const now = new Date();
  const actualHoursAgo = (now.getTime() - eventTime.getTime()) / (1000 * 60 * 60);
  const discrepancy = Math.abs(actualHoursAgo - expectedHoursAgo);
  
  return {
    valid: discrepancy <= 0.1, // Within 6 minutes
    discrepancyMinutes: discrepancy * 60,
  };
};

/**
 * Get current timezone info for debugging
 */
export const getTimezoneDebugInfo = () => {
  const now = new Date();
  const timezoneOffset = -now.getTimezoneOffset() / 60;
  const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  return {
    localTime: now.toLocaleString(),
    utcTime: now.toISOString(),
    timezoneName,
    timezoneOffset,
    timezoneString: `UTC${timezoneOffset >= 0 ? '+' : ''}${timezoneOffset}`,
  };
};

export default useTimeSyncValidation;

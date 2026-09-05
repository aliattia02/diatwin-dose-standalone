/**
 * Time Utilities Barrel Export
 * Location: mobile/utils/time/index.ts
 *
 * Main Exports: TimeManager (default and named), all time utility functions
 * Description: Central export point for all time-related utilities and the TimeManager object
 *
 * Features:
 * - Re-exports all TimeManager functions as named exports
 * - Exports TimeManager as both default and named export for flexibility
 * - Provides backward compatibility with existing import patterns
 *
 * Usage Examples:
 * ```typescript
 * // Named import (recommended)
 * import { TimeManager } from '@/utils/time';
 * TimeManager.getCurrentTimeISOString();
 *
 * // Individual function imports
 * import { getCurrentTimeISOString, normalizeToSecondBoundary } from '@/utils/time';
 *
 * // Default import (for backward compatibility)
 * import TimeManager from '@/utils/time';
 * ```
 */

export * from './TimeManager';
export { default as TimeManager } from './TimeManager';
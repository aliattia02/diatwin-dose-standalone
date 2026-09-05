/**
 * Theme constants for the NATIVE mobile app
 * Colors match the web app design system
 */

export const colors = {
  primary: '#8031A7',      // Purple (matching web)
  primaryLight: '#9B4ABF',
  primaryDark: '#5E2380',
  secondary: '#4a90e2',    // Blue
  secondaryLight: '#6BA8F5',
  secondaryDark: '#2D6BC0',
  success: '#4CAF50',      // Green
  successLight: '#81C784',
  successDark: '#388E3C',
  warning: '#FF8800',      // Orange
  warningLight: '#FFB74D',
  warningDark: '#F57C00',
  danger: '#FF4444',       // Red
  dangerLight: '#EF5350',
  dangerDark: '#D32F2F',
  background: '#F5F5F5',
  surface: '#FFFFFF',
  surfaceVariant: '#FAFAFA',
  border: '#E0E0E0',
  divider: '#EEEEEE',
  text: {
    primary: '#212121',
    secondary: '#757575',
    disabled: '#BDBDBD',
    inverse: '#FFFFFF',
  },
  glucose: {
    low: '#FF8800',        // Orange for low
    normal: '#4CAF50',     // Green for normal
    high: '#FF4444',       // Red for high
    veryLow: '#FF4444',    // Red for very low (dangerous)
    veryHigh: '#D32F2F',   // Dark red for very high
  },
  insulin: {
    rapid: '#4a90e2',      // Blue for rapid acting
    short: '#29B6F6',      // Light blue for short acting
    intermediate: '#9B4ABF', // Purple for intermediate
    long: '#8031A7',       // Dark purple for long acting
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const borderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const typography = {
  h1: { fontSize: 32, fontWeight: 'bold' as const, lineHeight: 40 },
  h2: { fontSize: 24, fontWeight: 'bold' as const, lineHeight: 32 },
  h3: { fontSize: 20, fontWeight: '600' as const, lineHeight: 28 },
  body: { fontSize: 16, fontWeight: 'normal' as const, lineHeight: 24 },
  bodyLarge: { fontSize: 18, fontWeight: 'normal' as const, lineHeight: 26 },
  caption: { fontSize: 14, fontWeight: 'normal' as const, lineHeight: 20 },
  small: { fontSize: 12, fontWeight: 'normal' as const, lineHeight: 16 },
  button: { fontSize: 16, fontWeight: '600' as const, lineHeight: 24 },
} as const;

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 1.0,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2.0,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
} as const;

export default {
  colors,
  spacing,
  borderRadius,
  typography,
  shadows,
};

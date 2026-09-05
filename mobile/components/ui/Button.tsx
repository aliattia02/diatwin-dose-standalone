/**
 * Button Component - Fixed for React Native Web
 * 
 * Removes accessibilityHint to fix console warning:
 * "React does not recognize the `accessibilityHint` prop on a DOM element"
 */

import React from 'react';
import { 
  TouchableOpacity, 
  Text, 
  StyleSheet, 
  ActivityIndicator,
  ViewStyle,
  TextStyle,
  Platform
} from 'react-native';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export interface ButtonProps {
  /** Text label — preferred shorthand used by most screens */
  title?: string;
  /** Alternative to title: pass JSX children directly */
  children?: React.ReactNode;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityLabel?: string;
  // Remove accessibilityHint to avoid console warning
}

export const Button: React.FC<ButtonProps> = ({
  title,
  children,
  onPress,
  variant = 'primary',
  size = 'medium',
  disabled = false,
  loading = false,
  fullWidth = false,
  style,
  textStyle,
  accessibilityLabel,
}) => {
  const getButtonStyles = (): ViewStyle[] => {
    const baseStyles: ViewStyle[] = [styles.button, styles[`button_${variant}`], styles[`button_${size}`]];

    if (fullWidth) {
      baseStyles.push(styles.buttonFullWidth);
    }

    if (disabled || loading) {
      baseStyles.push(styles.buttonDisabled);
    }

    if (style) {
      baseStyles.push(style);
    }

    return baseStyles;
  };

  const getTextStyles = (): TextStyle[] => {
    const baseStyles: TextStyle[] = [styles.text, styles[`text_${variant}`], styles[`text_${size}`]];

    if (disabled || loading) {
      baseStyles.push(styles.textDisabled);
    }

    if (textStyle) {
      baseStyles.push(textStyle);
    }

    return baseStyles;
  };

  const handlePress = () => {
    if (!disabled && !loading) {
      onPress();
    }
  };

  return (
    <TouchableOpacity
      style={getButtonStyles()}
      onPress={handlePress}
      disabled={disabled || loading}
      activeOpacity={0.7}
      accessibilityLabel={accessibilityLabel || (typeof (title ?? children) === 'string' ? (title ?? children) as string : 'Button')}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      // REMOVED: accessibilityHint to fix console warning on web
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'outline' || variant === 'ghost' ? colors.primary : colors.surface}
        />
      ) : (
        <Text style={getTextStyles()}>{title ?? children}</Text>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  buttonFullWidth: {
    width: '100%',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  
  // Variants
  button_primary: {
    backgroundColor: colors.primary,
  },
  button_secondary: {
    backgroundColor: colors.secondary,
  },
  button_outline: {
    backgroundColor: 'transparent',
    borderColor: colors.primary,
  },
  button_ghost: {
    backgroundColor: 'transparent',
  },
  button_danger: {
    backgroundColor: colors.danger,
  },
  
  // Sizes
  button_small: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  button_medium: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  button_large: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  
  // Text styles
  text: {
    ...typography.button,
    textAlign: 'center',
  },
  textDisabled: {
    opacity: 0.7,
  },
  
  // Text variants
  text_primary: {
    color: colors.surface,
  },
  text_secondary: {
    color: colors.surface,
  },
  text_outline: {
    color: colors.primary,
  },
  text_ghost: {
    color: colors.primary,
  },
  text_danger: {
    color: colors.surface,
  },
  
  // Text sizes
  text_small: {
    fontSize: 12,
  },
  text_medium: {
    fontSize: 14,
  },
  text_large: {
    fontSize: 16,
  },
});

export default Button;
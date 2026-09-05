/**
 * Loading spinner component
 */

import React from 'react';
import { View, ActivityIndicator, Text, StyleSheet, ViewStyle } from 'react-native';
import { colors, spacing, typography } from '@/constants/theme';

export interface LoadingProps {
  size?: 'small' | 'large';
  color?: string;
  text?: string;
  fullScreen?: boolean;
  overlay?: boolean;
  style?: ViewStyle;
}

export const Loading: React.FC<LoadingProps> = ({
  size = 'large',
  color = colors.primary,
  text,
  fullScreen = false,
  overlay = false,
  style,
}) => {
  const containerStyle = [
    styles.container,
    fullScreen && styles.fullScreen,
    overlay && styles.overlay,
    style,
  ];

  return (
    <View style={containerStyle}>
      <ActivityIndicator size={size} color={color} />
      {text && <Text style={styles.text}>{text}</Text>}
    </View>
  );
};

/**
 * Inline loading indicator for buttons or small areas
 */
export const InlineLoading: React.FC<{ color?: string }> = ({ color = colors.primary }) => (
  <ActivityIndicator size="small" color={color} />
);

/**
 * Full screen loading overlay
 */
export const FullScreenLoading: React.FC<{ text?: string }> = ({ text }) => (
  <Loading fullScreen overlay text={text} />
);

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  fullScreen: {
    flex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
  },
  overlay: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  text: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});

export default Loading;

/**
 * mobile/components/debug/ApiStatus.tsx - Debug component to display API connection status
 * Only visible in development mode
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { colors, spacing, typography, borderRadius } from '../../constants/theme';
import {
  checkApiConnectivity,
  getConnectivityErrorMessage,
  formatApiUrl,
  getConnectivityTips,
  type ConnectivityStatus,
} from '../../utils/connectivity';

interface ApiStatusProps {
  showAlways?: boolean;
  compact?: boolean;
}

export const ApiStatus: React.FC<ApiStatusProps> = ({
  showAlways = false,
  compact = false,
}) => {
  const [status, setStatus] = useState<ConnectivityStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const checkStatus = async () => {
    setIsChecking(true);
    const result = await checkApiConnectivity();
    setStatus(result);
    setIsChecking(false);
  };

  useEffect(() => {
    if (__DEV__ || showAlways) {
      checkStatus();
    }
  }, [showAlways]);

  // Don't render in production unless explicitly shown
  if (!__DEV__ && !showAlways) {
    return null;
  }

  // Don't show if connected and not expanded (in compact mode)
  if (compact && status?.apiReachable && !expanded) {
    return (
      <TouchableOpacity
        style={styles.compactIndicator}
        onPress={() => setExpanded(true)}
      >
        <View style={[styles.statusDot, styles.statusDotConnected]} />
      </TouchableOpacity>
    );
  }

  const getStatusColor = () => {
    if (!status) return colors.text.disabled;
    if (status.apiReachable) return colors.success;
    return colors.danger;
  };

  const getStatusIcon = () => {
    if (isChecking) return '⏳';
    if (!status) return '❓';
    if (status.apiReachable) return '✅';
    return '❌';
  };

  const tips = getConnectivityTips();

  if (compact) {
    return (
      <View style={styles.compactContainer}>
        <TouchableOpacity
          style={styles.compactHeader}
          onPress={() => setExpanded(!expanded)}
        >
          <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
          <Text style={styles.compactTitle}>
            API: {status?.apiReachable ? 'Connected' : 'Disconnected'}
          </Text>
          <Text style={styles.expandIcon}>{expanded ? '▼' : '▶'}</Text>
        </TouchableOpacity>

        {expanded && (
          <View style={styles.compactDetails}>
            <Text style={styles.detailText}>
              URL: {status ? formatApiUrl(status.apiUrl) : 'Unknown'}
            </Text>
            {status?.latency && (
              <Text style={styles.detailText}>Latency: {status.latency}ms</Text>
            )}
            {status?.error && (
              <Text style={[styles.detailText, styles.errorText]}>
                {getConnectivityErrorMessage(status)}
              </Text>
            )}
            <TouchableOpacity style={styles.refreshButton} onPress={checkStatus}>
              <Text style={styles.refreshButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>🔌 API Status</Text>
        <TouchableOpacity
          style={styles.refreshIconButton}
          onPress={checkStatus}
          disabled={isChecking}
        >
          {isChecking ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.refreshIcon}>🔄</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusIcon}>{getStatusIcon()}</Text>
        <View style={styles.statusInfo}>
          <Text style={[styles.statusText, { color: getStatusColor() }]}>
            {status?.apiReachable ? 'Connected' : 'Disconnected'}
          </Text>
          <Text style={styles.urlText}>
            {status ? formatApiUrl(status.apiUrl) : 'Checking...'}
          </Text>
        </View>
        {status?.latency && (
          <Text style={styles.latencyText}>{status.latency}ms</Text>
        )}
      </View>

      {status?.error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>⚠️ Connection Error</Text>
          <Text style={styles.errorMessage}>
            {getConnectivityErrorMessage(status)}
          </Text>
        </View>
      )}

      {status?.error && (
        <View style={styles.tipsContainer}>
          <Text style={styles.tipsTitle}>💡 Troubleshooting Tips:</Text>
          {tips.map((tip, index) => (
            <Text key={index} style={styles.tipText}>
              • {tip}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    margin: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
  },
  refreshIconButton: {
    padding: spacing.xs,
  },
  refreshIcon: {
    fontSize: 20,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    fontSize: 24,
    marginRight: spacing.sm,
  },
  statusInfo: {
    flex: 1,
  },
  statusText: {
    ...typography.body,
    fontWeight: '600',
  },
  urlText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  latencyText: {
    ...typography.small,
    color: colors.text.secondary,
    backgroundColor: colors.surfaceVariant,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
  },
  errorContainer: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.danger + '10',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.danger,
    marginBottom: spacing.xs,
  },
  errorMessage: {
    ...typography.small,
    color: colors.text.primary,
    lineHeight: 20,
  },
  tipsContainer: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.warning + '10',
    borderRadius: borderRadius.md,
  },
  tipsTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.warning,
    marginBottom: spacing.sm,
  },
  tipText: {
    ...typography.small,
    color: colors.text.primary,
    marginBottom: spacing.xs,
    lineHeight: 18,
  },
  compactContainer: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  compactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.sm,
  },
  compactTitle: {
    ...typography.small,
    color: colors.text.secondary,
    flex: 1,
    marginLeft: spacing.sm,
  },
  expandIcon: {
    fontSize: 10,
    color: colors.text.disabled,
  },
  compactDetails: {
    padding: spacing.sm,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  detailText: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  errorText: {
    color: colors.danger,
  },
  refreshButton: {
    marginTop: spacing.xs,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
    alignSelf: 'flex-start',
  },
  refreshButtonText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  compactIndicator: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    padding: spacing.xs,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusDotConnected: {
    backgroundColor: colors.success,
  },
});

export default ApiStatus;
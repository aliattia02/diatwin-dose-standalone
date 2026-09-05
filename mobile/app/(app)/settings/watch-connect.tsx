/**
 * watch-connect.tsx — Google Fit OAuth Connect Screen
 * Location: mobile/app/(app)/settings/watch-connect.tsx
 *
 * The flow:
 *   1. User taps "Connect Google Fit".
 *   2. Screen fetches the consent URL from GET /api/watch/oauth-url.
 *   3. A WebView opens the consent page.
 *   4. Google redirects to the deep-link URI (e.g. com.diatwin.mobile://auth/watch?code=...)
 *   5. The WebView navigation-change handler captures the code.
 *   6. We POST { code } to POST /api/watch/connect.
 *   7. On success → navigate back to the watch settings screen.
 *
 * No credentials are entered — this is a pure OAuth handshake.
 * After the first connect the backend scheduler takes over forever.
 */

import React, { useState, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { router } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import { getWatchOAuthUrl, connectWatch } from '@/services/api/watch-sync';

// ── Deep-link redirect URI registered in Google Cloud Console ─────────────────
// Must match GOOGLE_REDIRECT_URI in your backend .env exactly.
const REDIRECT_URI_PREFIX = 'com.diatwin.mobile://auth/watch';

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function WatchConnectScreen() {
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [showWebView,  setShowWebView]  = useState(false);
  const [oauthUrl,     setOauthUrl]     = useState('');
  const [error,        setError]        = useState<string | null>(null);

  // ── Step 1: fetch consent URL from backend ───────────────────────────────
  const handlePressConnect = async () => {
    setError(null);
    setIsLoadingUrl(true);
    try {
      const url = await getWatchOAuthUrl();
      setOauthUrl(url);
      setShowWebView(true);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Could not load Google sign-in');
    } finally {
      setIsLoadingUrl(false);
    }
  };

  // ── Step 2: WebView captures the redirect and extracts ?code= ─────────────
  const handleWebViewNav = async (nav: WebViewNavigation) => {
    const { url } = nav;

    // Google redirects to our deep-link URI after consent
    if (!url.startsWith(REDIRECT_URI_PREFIX)) return;

    // Close the WebView immediately — don't let it try to load the deep-link
    setShowWebView(false);

    // Extract the auth code from the redirect URL
    const match = url.match(/[?&]code=([^&]+)/);
    if (!match) {
      // User denied consent
      setError('Google sign-in was cancelled or access was denied.');
      return;
    }

    const code = decodeURIComponent(match[1]);

    // ── Step 3: exchange code with backend ─────────────────────────────────
    setIsConnecting(true);
    try {
      const result = await connectWatch({ code });

      Alert.alert(
        'Google Fit Connected! 🎉',
        `Linked to ${result.status.google_name ?? result.status.google_email ?? 'your Google account'}.\n` +
        `${result.sync_result?.new_count ?? 0} activity session(s) synced.`,
        [
          {
            text: 'Done',
            onPress: () => router.replace('/(app)/settings/watch' as any),
          },
        ],
      );
    } catch (e: any) {
      setError(
        e?.response?.data?.error ??
        e?.message ??
        'Connection failed. Please try again.',
      );
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Explainer card ─────────────────────────────────────────────── */}
        <View style={styles.infoCard}>
          <Text style={styles.infoIcon}>⌚</Text>
          <View style={styles.infoBody}>
            <Text style={styles.infoTitle}>How it works</Text>
            <Text style={styles.infoText}>
              DiaTwin connects to <Text style={styles.infoBold}>Google Fit</Text> to pull
              your heart rate data automatically. This works with any watch that syncs
              to Google Fit — Pixel Watch, Galaxy Watch, Wear OS devices, and more.
            </Text>
            <Text style={[styles.infoText, { marginTop: 6 }]}>
              You only sign in once. After that DiaTwin fetches HR data in the
              background every 15 minutes and automatically creates activity sessions
              for your glucose model.
            </Text>
          </View>
        </View>

        {/* ── What happens card ──────────────────────────────────────────── */}
        <View style={styles.stepsCard}>
          {[
            { icon: '1', text: 'Sign into Google and grant heart rate access' },
            { icon: '2', text: 'DiaTwin polls Google Fit every 15 minutes' },
            { icon: '3', text: 'HR data is segmented into activity sessions' },
            { icon: '4', text: 'Sessions feed the glucose pharmacodynamics model' },
          ].map((step) => (
            <View key={step.icon} style={styles.stepRow}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepNum}>{step.icon}</Text>
              </View>
              <Text style={styles.stepText}>{step.text}</Text>
            </View>
          ))}
        </View>

        {/* ── Error banner ───────────────────────────────────────────────── */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>⚠ {error}</Text>
          </View>
        )}

        {/* ── Connect button ─────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[
            styles.connectBtn,
            (isLoadingUrl || isConnecting) && styles.connectBtnDisabled,
          ]}
          onPress={handlePressConnect}
          disabled={isLoadingUrl || isConnecting}
          activeOpacity={0.8}
        >
          {isLoadingUrl || isConnecting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.googleLogo}>G</Text>
              <Text style={styles.connectBtnText}>Sign in with Google</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => router.back()}
          disabled={isLoadingUrl || isConnecting}
          activeOpacity={0.7}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        {/* ── Privacy note ───────────────────────────────────────────────── */}
        <Text style={styles.privacyNote}>
          🔒 DiaTwin only requests read-only access to your heart rate data.
          Your Google credentials are never stored — only an access token that
          expires automatically.
        </Text>

      </ScrollView>

      {/* ── OAuth WebView modal ────────────────────────────────────────────── */}
      <Modal
        visible={showWebView}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowWebView(false)}
      >
        <View style={styles.webViewContainer}>
          {/* Header */}
          <View style={styles.webViewHeader}>
            <Text style={styles.webViewTitle}>Sign in with Google</Text>
            <Pressable
              style={styles.webViewClose}
              onPress={() => setShowWebView(false)}
            >
              <Text style={styles.webViewCloseText}>✕</Text>
            </Pressable>
          </View>

          {/* The consent page */}
          {oauthUrl ? (
            <WebView
              source={{ uri: oauthUrl }}
              onNavigationStateChange={handleWebViewNav}
              // Intercept the redirect before the WebView tries to resolve it
              onShouldStartLoadWithRequest={(req) => {
                if (req.url.startsWith(REDIRECT_URI_PREFIX)) {
                  // Fire the handler but return false so WebView doesn't load
                  handleWebViewNav(req as any);
                  return false;
                }
                return true;
              }}
              startInLoadingState
              renderLoading={() => (
                <View style={styles.webViewLoading}>
                  <ActivityIndicator size="large" color={colors.primary ?? '#6366f1'} />
                </View>
              )}
              style={styles.webView}
              // Google blocks default WebView user-agents on some platforms
              userAgent={
                Platform.OS === 'android'
                  ? 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/116 Mobile Safari/537.36'
                  : undefined
              }
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md ?? 16,
    paddingBottom: 40,
  },

  // ── Info card ──────────────────────────────────────────────────────────────
  infoCard: {
    flexDirection: 'row',
    backgroundColor: (colors.primary ?? '#6366f1') + '12',
    borderWidth: 1,
    borderColor: (colors.primary ?? '#6366f1') + '30',
    borderRadius: 12,
    padding: 14,
    marginBottom: spacing.md ?? 16,
    gap: 10,
  },
  infoIcon: { fontSize: 24, marginTop: 1 },
  infoBody: { flex: 1 },
  infoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 4,
  },
  infoText: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 18,
  },
  infoBold: {
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
  },

  // ── Steps card ─────────────────────────────────────────────────────────────
  stepsCard: {
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 14,
    padding: spacing.md ?? 16,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    marginBottom: spacing.md ?? 16,
    gap: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: (colors.primary ?? '#6366f1') + '22',
    borderWidth: 1,
    borderColor: colors.primary ?? '#6366f1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNum: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary ?? '#6366f1',
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 18,
    paddingTop: 2,
  },

  // ── Error banner ───────────────────────────────────────────────────────────
  errorBanner: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 10,
    padding: 12,
    marginBottom: spacing.md ?? 16,
  },
  errorText: {
    fontSize: 13,
    color: '#ef4444',
    lineHeight: 18,
  },

  // ── Buttons ────────────────────────────────────────────────────────────────
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4285F4',   // Google blue
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 10,
    gap: 10,
  },
  connectBtnDisabled: { opacity: 0.5 },
  googleLogo: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  connectBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  cancelBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    color: colors.text?.secondary ?? '#94a3b8',
  },

  // ── Privacy note ───────────────────────────────────────────────────────────
  privacyNote: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#64748b',
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 8,
    marginTop: spacing.md ?? 16,
  },

  // ── WebView modal ──────────────────────────────────────────────────────────
  webViewContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  webViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border ?? '#2a2d3a',
  },
  webViewTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
  },
  webViewClose: {
    padding: 6,
  },
  webViewCloseText: {
    fontSize: 16,
    color: colors.text?.secondary ?? '#94a3b8',
  },
  webView: {
    flex: 1,
  },
  webViewLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});

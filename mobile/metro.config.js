const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer = {
  ...config.transformer,
  unstable_transformProfile: 'default',
  // Force Metro/Babel to transform packages that use import.meta
  // (zustand v5 devtools middleware uses import.meta.env in its dist files)
  transformIgnorePatterns: [
    'node_modules/(?!' +
      '(jest-)?react-native' +
      '|@react-native(-community)?' +
      '|expo(nent)?' +
      '|@expo(nent)?(/.*)?' +
      '|@expo-google-fonts/.*' +
      '|react-navigation' +
      '|@react-navigation/.*' +
      '|@unimodules/.*' +
      '|unimodules' +
      '|sentry-expo' +
      '|native-base' +
      '|react-native-svg' +
      '|react-native-get-random-values' +
      '|zustand' +
    ')',
  ],
};

module.exports = config;
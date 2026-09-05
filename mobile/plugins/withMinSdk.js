/**
 * plugins/withMinSdk.js
 *
 * Ensures the minSdkVersion set in app.json propagates correctly
 * into the generated Gradle files during `expo prebuild`.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withMinSdk(config) {
  return withAppBuildGradle(config, (config) => {
    const minSdk = config.android?.minSdkVersion ?? 26;
    config.modResults.contents = config.modResults.contents.replace(
      /minSdkVersion\s+\d+/,
      `minSdkVersion ${minSdk}`
    );
    return config;
  });
};
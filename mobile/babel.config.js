module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Transforms import.meta → compatible syntax for Metro web builds
      // Required for zustand v5 which uses import.meta.env in its dist files
      'babel-plugin-transform-import-meta',
    ],
  };
};
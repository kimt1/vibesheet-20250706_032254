module.exports = {
  transform: {
    // Use babel-jest to transpile tests with the babel preset
    '^.+\\.(js|jsx)$': 'babel-jest',
    // Force babel-jest to transform gettext-parser
    '[/\\\\]node_modules[/\\\\]gettext-parser[/\\\\].+\\.js$': 'babel-jest',
  },
  // We are now using the transform key to handle this, so we can reset transformIgnorePatterns to default or remove it
  // For safety, let's keep the ignore pattern but ensure it doesn't conflict.
  // The default is /node_modules/, so we still need to un-ignore gettext-parser.
  transformIgnorePatterns: [
    '/node_modules/(?!(gettext-parser)/)',
  ],
  testEnvironment: 'node',
};

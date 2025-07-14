const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin'); // To copy manifest.json and icons

module.exports = {
  mode: process.env.NODE_ENV || 'development', // Default to development if not set
  entry: {
    background: './background.js',
    contentScript: './contentScript.js', // Corrected name
    popup: './popup.jsx',
    options: './options.jsx',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].bundle.js',
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          // Options are now in babel.config.js
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'], // Process CSS files
      },
    ],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: './manifest.json', to: 'manifest.json' },
        { from: './popup.html', to: 'popup.html' },
        { from: './options.html', to: 'options.html' },
        // Add any other static assets like icons if they are not referenced elsewhere
        // For example, if your icons are in an 'icons' folder:
        // { from: 'icons', to: 'icons' }
        // However, manifest.json already references icons from an 'icons' folder,
        // so make sure that folder exists at the root or adjust the path.
        // For now, assuming icons are handled or will be added to root/icons
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.jsx'], // Allow importing .jsx without specifying extension
  },
  devtool: process.env.NODE_ENV === 'production' ? false : 'cheap-module-source-map', // Source maps for development
};

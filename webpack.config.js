const path = require('path');
const GasPlugin = require('gas-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: './src/main.ts',
  output: {
    filename: 'Code.js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'this',
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  optimization: { minimize: false },
  plugins: [
    new GasPlugin(),
    new CopyPlugin({
      patterns: [{ from: 'src/appsscript.json', to: 'appsscript.json' }],
    }),
  ],
};

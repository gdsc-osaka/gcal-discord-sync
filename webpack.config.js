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
    // gas-webpack-plugin scans the entry module's `export function …` declarations
    // and prepends top-level stub function declarations to the bundle, so the GAS
    // editor's static analyzer can list them in the function picker.
    new GasPlugin({ autoGlobalExportsFiles: ['src/main.ts'] }),
    new CopyPlugin({
      patterns: [{ from: 'src/appsscript.json', to: 'appsscript.json' }],
    }),
  ],
};

const path = require('path');
module.exports = {
  mode: 'production',
  entry: './src/client-entry.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'client.js'
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    extensionAlias: {
      '.js': ['.js', '.ts', '.tsx']
    }
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  }
};

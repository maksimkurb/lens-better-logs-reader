const path = require("path");

const mode = process.env.NODE_ENV ?? "production";

const base = (entry, target, filename, externals) => ({
  entry,
  target,
  mode,
  devtool: mode === "development" ? "cheap-module-source-map" : false,
  module: { rules: [{ test: /\.tsx?$/, use: "ts-loader", exclude: /node_modules/ }] },
  externals: [externals],
  resolve: { extensions: [".tsx", ".ts", ".js"] },
  output: {
    libraryTarget: "commonjs2",
    globalObject: "this",
    filename,
    path: path.resolve(__dirname, "dist"),
  },
  node: { __dirname: false, __filename: false },
});

module.exports = [
  base("./main.ts", "electron-main", "main.js", {
    "@freelensapp/extensions": "var global.LensExtensions",
  }),
  base("./renderer.tsx", "electron-renderer", "renderer.js", {
    "@freelensapp/extensions": "var global.LensExtensions",
    react: "var global.React",
    "react-dom": "var global.ReactDOM",
    mobx: "var global.Mobx",
    "mobx-react": "var global.MobxReact",
  }),
];

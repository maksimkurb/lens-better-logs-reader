import { build, context } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");

// Libraries the host provides; each resolves to a property of the global the host publishes.
const HOST = {
  react: "React",
  "react-dom": "ReactDom",
  "react/jsx-runtime": "ReactJsxRuntime",
  mobx: "Mobx",
  "mobx-react": "MobxReact",
  "monaco-editor": "MonacoEditor",
};

const hostModules = (names) => ({
  name: "host-modules",
  setup(b) {
    const filter = new RegExp(`^(${names.map((n) => n.replace(/[/]/g, "\\/")).join("|")})$`);
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "host" }));
    b.onLoad({ filter: /.*/, namespace: "host" }, (a) => {
      let keys = [];
      try {
        keys = Object.keys(require(a.path)).filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
      } catch {}
      const lines = [
        `const m = globalThis.FreelensExtensionApi.${HOST[a.path]};`,
        "export default m;",
        ...keys.map((k) => `export const ${k} = m.${k};`),
      ];
      return { contents: lines.join("\n"), loader: "js" };
    });
  },
});

const common = {
  bundle: true,
  format: "esm",
  target: "esnext",
  jsx: "automatic",
  outdir: "dist",
  sourcemap: watch ? "linked" : false,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
};

const jobs = [
  { ...common, entryPoints: ["main.ts"], platform: "node", plugins: [hostModules(["mobx"])] },
  { ...common, entryPoints: ["renderer.tsx"], platform: "browser", plugins: [hostModules(Object.keys(HOST))] },
];

if (watch) {
  for (const job of jobs) await (await context(job)).watch();
} else {
  await Promise.all(jobs.map((job) => build(job)));
}

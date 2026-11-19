import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

export function buildOptions(production) {
  return {
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    platform: "browser",

    target: "es2021",

    jsx: "automatic",
    jsxImportSource: "preact",

    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    outfile: "main.js",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],

    minify: false,
    sourcemap: production ? false : "inline",

    legalComments: "eof",
    treeShaking: true,
    logLevel: "info",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const production = process.argv[2] === "production";
  if (production) {
    await esbuild.build(buildOptions(true));
  } else {
    const context = await esbuild.context(buildOptions(false));
    await context.watch();
  }
}

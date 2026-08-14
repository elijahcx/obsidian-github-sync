import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

// Keep Node builtins external (Electron provides them on desktop) EXCEPT
// `buffer`: mobile has no Node runtime, so `buffer` must be bundled from the
// npm polyfill and `Buffer` injected as a global. See buffer-shim.mjs.
const externalBuiltins = builtinModules.filter((m) => m !== "buffer");

esbuild.build({
  banner: { js: "/* Git Sync Vault */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...externalBuiltins,
  ],
  inject: ["buffer-shim.mjs"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

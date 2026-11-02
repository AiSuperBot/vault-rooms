import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// Replace lib0 modules that introduce forbidden environment and logging calls.
// Either path separator: on Windows esbuild hands onLoad backslash paths.
const lib0ShimPlugin = {
  name: "lib0-shims",
  setup(build) {
    build.onLoad({ filter: /[\\/]lib0[\\/]environment\.js$/ }, async () => ({
      contents: await readFile(here + "src/vendor-shims/lib0-environment.js", "utf8"),
      loader: "js"
    }));
    build.onLoad({ filter: /[\\/]lib0[\\/]logging(\.node)?\.js$/ }, async () => ({
      contents: await readFile(here + "src/vendor-shims/lib0-logging.js", "utf8"),
      loader: "js"
    }));
  }
};

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [lib0ShimPlugin],
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtinModules],
  format: "cjs",
  platform: "node",
  target: "es2018",
  minify: true,
  legalComments: "eof",
  logLevel: "info",
  outfile: "main.js",
  write: false
});

const output = result.outputFiles.find((file) => file.path.endsWith("main.js"));
if (!output) {
  throw new Error("esbuild did not produce main.js");
}
// Some preserved third-party license blocks contain line-end spaces. Normalize only whitespace at
// EOL so the committed artifact remains license-complete and passes git diff --check reproducibly.
await writeFile("main.js", output.text.replace(/[\t ]+$/gm, ""));

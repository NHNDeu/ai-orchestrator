import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle MCP server into CommonJS
await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: path.join(distDir, "server.cjs"),
  sourcemap: false,
  minify: false,
});

// 2. Bundle UI script into standalone IIFE
const uiResult = await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "ui", "app.ts")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  write: false,
  minify: true,
});

const jsBundle = uiResult.outputFiles[0].text;
const css = fs.readFileSync(path.join(rootDir, "src", "ui", "styles.css"), "utf8");
const template = fs.readFileSync(
  path.join(rootDir, "src", "ui", "template.html"),
  "utf8",
);

const finalHtml = template
  .replace("/*__INLINE_CSS__*/", () => css)
  .replace("/*__INLINE_JS__*/", () => jsBundle);

fs.writeFileSync(path.join(distDir, "dashboard.html"), finalHtml, "utf8");

console.log(
  `Built dist/server.cjs (${fs.statSync(path.join(distDir, "server.cjs")).size} B) and dist/dashboard.html (${fs.statSync(path.join(distDir, "dashboard.html")).size} B)`,
);

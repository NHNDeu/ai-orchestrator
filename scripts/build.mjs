import { execFileSync } from "node:child_process";
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

// 3. Compile zero-dependency Windows ConPTY helper (win32 only)
let conptyInfo = "";
if (process.platform === "win32") {
  const cscCandidates = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ];
  const cscPath = cscCandidates.find((p) => fs.existsSync(p));
  if (!cscPath) {
    throw new Error(
      "Cannot locate .NET Framework csc.exe to compile src/uu/conpty.cs",
    );
  }
  const conptySrc = path.join(rootDir, "src", "uu", "conpty.cs");
  const conptyExe = path.join(distDir, "uu-conpty.exe");
  execFileSync(
    cscPath,
    ["/nologo", "/optimize+", "/target:exe", `/out:${conptyExe}`, conptySrc],
    { cwd: rootDir, stdio: "inherit", windowsHide: true },
  );
  conptyInfo = ` and dist/uu-conpty.exe (${fs.statSync(conptyExe).size} B)`;
}

console.log(
  `Built dist/server.cjs (${fs.statSync(path.join(distDir, "server.cjs")).size} B), dist/dashboard.html (${fs.statSync(path.join(distDir, "dashboard.html")).size} B)${conptyInfo}`,
);

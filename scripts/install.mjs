import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const targetDir = path.join(
  os.homedir(),
  ".gemini",
  "config",
  "plugins",
  "ai-orchestrator",
);

console.log("[ai-orchestrator] Building production bundles...");
execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

fs.mkdirSync(targetDir, { recursive: true });

for (const file of ["plugin.json", "mcp_config.json"]) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(targetDir, file));
}

for (const dir of ["assets", "rules", "skills", "dist"]) {
  const src = path.join(repoRoot, dir);
  const dst = path.join(targetDir, dir);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
  }
  fs.cpSync(src, dst, { recursive: true });
}

console.log(`\nInstalled ai-orchestrator plugin to:\n  ${targetDir}`);
console.log("\nNext steps:");
console.log("  1. Restart or refresh MCP Servers in Google Antigravity.");
console.log(
  '  2. Open "AI Orchestrator" from the Left Sidebar or Side Pane "+" menu.',
);

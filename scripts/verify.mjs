import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(pluginRoot, "dist", "server.cjs");
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-orch-test-"));

class McpTestClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.proc = spawn("node", [serverPath, `--data-dir=${tempDataDir}`], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split(/\r?\n/);
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    this.proc.stderr.on("data", (d) => {
      process.stderr.write(`[server stderr] ${d.toString()}`);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  close() {
    this.proc.kill();
  }
}

const fullCheck = process.argv.includes("--full");
const client = new McpTestClient();
try {
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-script", version: "2.0.0" },
  });
  client.notify("notifications/initialized", {});
  assert.ok(init.capabilities.tools, "Server must advertise tools");
  assert.ok(init.capabilities.resources, "Server must advertise resources");
  console.log("[1/5] initialize OK");

  const toolsList = await client.request("tools/list", {});
  const tools = toolsList.tools;
  assert.equal(tools.length, 12, `Expected 12 tools, got ${tools.length}`);
  for (const t of tools) {
    const fullName = `mcp_ai-orchestrator_hub_${t.name}`;
    assert.ok(
      fullName.length <= 64,
      `Tool name ${fullName} exceeds 64 chars (${fullName.length})`,
    );
  }
  const resumeTool = tools.find((t) => t.name === "resume_worker");
  assert.deepEqual(resumeTool._meta?.ui?.visibility, ["model", "app"]);
  console.log("[2/5] tools/list & <=64 char prefix checks OK (12 tools)");

  const resRead = await client.request("resources/read", {
    uri: "ui://ai-orchestrator/dashboard.html",
  });
  const html = resRead.contents?.[0]?.text || "";
  assert.equal(resRead.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.ok(
    html.includes("workspace") &&
      html.includes("steps-panel") &&
      html.includes("followupInput") &&
      html.length > 5000,
    "Dashboard HTML must contain Codex-style layout and composer",
  );
  console.log(`[3/5] resources/read OK (${html.length} bytes HTML)`);

  const envRes = await client.request("tools/call", {
    name: "codex_env",
    arguments: { refresh: true },
  });
  const envData = envRes.structuredContent.environment;
  assert.ok(envData.codexPath, "codexPath must be resolved");
  assert.equal(envData.loggedIn, true, "Codex must be logged in");
  assert.ok(envData.quota, "Must include Codex quota");
  assert.ok(envData.claude?.claudePath, "claudePath must be resolved");
  assert.equal(envData.claude?.configured, true, "Claude must be configured");
  assert.equal(envData.claude?.canAutoUse, true, "Claude must be usable");
  console.log(
    `[4/5] codex_env OK (GPT: ${envData.quota.health} | Claude: ${envData.claude.claudeVersion} @ ${envData.claude.baseUrl})`,
  );

  if (fullCheck) {
    const dispatchRes = await client.request("tools/call", {
      name: "dispatch_workers",
      arguments: {
        batchTitle: "Claude Smoke Verification",
        cwd: pluginRoot,
        tasks: [
          {
            name: "Claude Smoke Worker",
            engine: "claude",
            model: "claude-sonnet-5-5",
            effort: "low",
            mode: "read-only",
            steps: ["读取要求", "返回确认"],
            prompt:
              "Do not use any tools. Reply with '[STEP 1/2]'\n'[STEP 2/2]'\nCLAUDE_OK",
          },
        ],
      },
    });
    const taskId = dispatchRes.structuredContent.dispatchedTaskIds[0];
    assert.ok(taskId && taskId.startsWith("cld_"), "Expected cld_* taskId");

    let task = null;
    for (let i = 0; i < 3; i++) {
      const statusRes = await client.request("tools/call", {
        name: "workers_status",
        arguments: { taskIds: [taskId], waitSec: 30 },
      });
      task = statusRes.structuredContent.watchedTasks[0];
      if (task && !["queued", "running"].includes(task.status)) break;
    }
    assert.equal(
      task.status,
      "completed",
      `Expected completed, got ${task.status}: ${task.error}`,
    );
    assert.equal(task.progress, 100);
    console.log(`[5/5] live Claude dispatch OK (${taskId})`);
  } else {
    console.log("[5/5] skipped live LLM call (pass --full to run)");
  }
} finally {
  client.close();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tempDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch {
    // Windows temp cleanup best-effort
  }
}

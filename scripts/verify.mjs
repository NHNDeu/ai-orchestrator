import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(pluginRoot, "dist", "server.cjs");
const conptyExePath = path.join(pluginRoot, "dist", "uu-conpty.exe");

class McpTestClient {
  constructor(dataDir, extraEnv = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.proc = spawn("node", [serverPath, `--data-dir=${dataDir}`], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
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
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  async close() {
    const closed = new Promise((resolve) => {
      this.proc.once("close", resolve);
    });
    try {
      this.proc.stdin.end();
    } catch { }
    const timer = setTimeout(() => {
      try {
        this.proc.kill();
      } catch { }
    }, 1500);
    await closed;
    clearTimeout(timer);
  }
}

function createMockUuCli(dir) {
  const statePath = path.join(dir, "mock-uu-state.json");
  const scriptPath = path.join(dir, "mock-uuyc-cli.mjs");
  fs.writeFileSync(
    statePath,
    JSON.stringify({ sessions: { dev_win_1: [], dev_mac_1: [] } }),
    "utf8",
  );
  const mockSrc = `
import fs from "node:fs";
const stateFile = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}
function writeState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s), "utf8");
}

function main() {
  if (args[0] === "status") {
    console.log(JSON.stringify({
      success: true,
      data: {
        appVersion: "4.48.4-mock",
        isLoggedIn: true,
        serviceStatus: "running",
        networkStatus: "connected",
      },
    }));
    process.exit(0);
  }

  if (args[0] === "device" && args[1] === "list") {
    console.log(JSON.stringify({
      success: true,
      data: {
        items: [
          { deviceId: "dev_win_1", deviceName: "MockWinPC", platform: "Windows", isOnline: true, lastSeen: null },
          { deviceId: "dev_mac_1", deviceName: "MockMac", platform: "macOS", isOnline: true, lastSeen: null },
        ],
        total: 2,
      },
    }));
    process.exit(0);
  }

  if (args[0] === "term") {
    const dIdx = args.indexOf("-d");
    const devId = dIdx >= 0 ? args[dIdx + 1] : "";
    const sub = args[dIdx + 2];
    const st = readState();
    const list = st.sessions[devId] || [];

    if (sub === "ls") {
      console.log("[连接] 初始化连接\\n[连接] 优化连接路径\\n" + JSON.stringify({ success: true, data: { items: list, total: list.length } }));
      process.exit(0);
    }
    if (sub === "has") {
      const name = args[dIdx + 3];
      process.exit(list.some((x) => x.name === name) ? 0 : 1);
    }
    if (sub === "kill") {
      const name = args[dIdx + 3];
      st.sessions[devId] = list.filter((x) => x.name !== name);
      writeState(st);
      process.exit(0);
    }
    if (sub === "rename") {
      const oldN = args[dIdx + 3];
      const newN = args[dIdx + 4];
      st.sessions[devId] = list.map((x) => (x.name === oldN ? { ...x, name: newN } : x));
      writeState(st);
      process.exit(0);
    }
    if (sub === "new" || sub === "attach") {
      const name = args[dIdx + 3] || "orch-default";
      const sIdx = args.indexOf("--shell");
      const shell = sIdx >= 0 ? args[sIdx + 1] : "powershell";
      if (sub === "new" && !list.some((x) => x.name === name)) {
        list.push({ name, shell, active: true });
        st.sessions[devId] = list;
        writeState(st);
      }
      process.stdout.write("\\x1b[32mMock UU Terminal Ready\\x1b[0m\\r\\nPS C:\\\\> ");
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split(/[\\r\\n]+/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          process.stdout.write(line + "\\r\\n");
          const probeMatch = line.match(/READY_([0-9a-f]+)__/);
          if (probeMatch) {
            process.stdout.write("__UU_READY_" + probeMatch[1] + "__\\r\\nPS C:\\\\> ");
            continue;
          }
          const beginMatch = line.match(/BEGIN_([0-9a-f]+)__/);
          const b64Match = line.match(/FromBase64String\\('([^']+)'\\)|printf '%s' '([^']+)'/);
          if (beginMatch) {
            const reqId = beginMatch[1];
            let decoded = "";
            if (b64Match) {
              const b64 = b64Match[1] || b64Match[2] || "";
              decoded = Buffer.from(b64, "base64").toString("utf8").replace(/^\\ufeff/, "");
            }
            let out = "OK";
            let ec = 0;
            if (decoded.includes("中文测试OK")) out = "中文测试OK";
            else if (decoded.includes("FAIL_CODE_7")) { out = "err7"; ec = 7; }
            process.stdout.write("__UU_BEGIN_" + reqId + "__\\r\\n");
            process.stdout.write(out + "\\r\\n");
            process.stdout.write("__UU_END_" + reqId + "_" + ec + "__\\r\\nPS C:\\\\> ");
          }
        }
      });
      return;
    }
  }
  process.exit(1);
}
main();
`;
  fs.writeFileSync(scriptPath, mockSrc, "utf8");
  return scriptPath;
}

async function runUuOfflineSuite() {
  const uuTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uu-orch-verify-"));
  const mockCliPath = createMockUuCli(uuTempDir);
  const missingDataDir = path.join(uuTempDir, "data-missing");
  const mockDataDir = path.join(uuTempDir, "data-mock");

  try {
    // 1. Missing CLI graceful degradation
    const cMissing = new McpTestClient(missingDataDir, { UU_CLI_PATH: "" });
    try {
      await cMissing.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "uu-verify", version: "2.0.0" },
      });
      cMissing.notify("notifications/initialized", {});
      const devMissing = await cMissing.request("tools/call", {
        name: "uu_devices",
        arguments: { refresh: true },
      });
      assert.notEqual(devMissing.isError, true, "uu_devices must not set isError when CLI is missing");
      assert.equal(devMissing.structuredContent.available, false);
    } finally {
      await cMissing.close();
    }

    // 2. Full mock UU flow: disabled -> enabled -> pending -> approve+allowlist -> allowed -> dangerous pending -> readOnly deny
    const cMock = new McpTestClient(mockDataDir, {
      UU_CLI_PATH: mockCliPath,
      UU_PTY_MODE: "pipe",
    });
    try {
      await cMock.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "uu-verify", version: "2.0.0" },
      });
      cMock.notify("notifications/initialized", {});

      const devRes = await cMock.request("tools/call", {
        name: "uu_devices",
        arguments: { refresh: true },
      });
      assert.equal(
        devRes.structuredContent.available,
        true,
        `Expected available=true, got reason: ${devRes.structuredContent.reason}, cliPath: ${devRes.structuredContent.cliPath}`,
      );
      assert.equal(devRes.structuredContent.devices.length, 2);
      assert.equal(devRes.structuredContent.settings.enabled, false);

      // Default disabled blocks exec
      const disabledExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: { deviceId: "dev_win_1", action: "exec", command: "echo hi" },
      });
      assert.equal(disabledExec.structuredContent.ok, false);
      assert.equal(disabledExec.structuredContent.pending, undefined);

      // Enable UU remote
      await cMock.request("tools/call", {
        name: "app_uu_settings",
        arguments: { enabled: true },
      });

      // Non-allowlisted device queues pending
      const pendingExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_win_1",
          action: "exec",
          command: "Write-Output '中文测试OK'",
        },
      });
      assert.equal(pendingExec.structuredContent.ok, false);
      const pendingId = pendingExec.structuredContent.pending?.id;
      assert.ok(pendingId, "Expected pending approval id");

      // Approve and add to allowlist
      const approveRes = await cMock.request("tools/call", {
        name: "app_uu_act",
        arguments: {
          op: "approve",
          pendingId,
          alsoAllowDevice: true,
        },
      });
      assert.equal(approveRes.structuredContent.ok, true);
      assert.equal(
        approveRes.structuredContent.uu.devices.find((d) => d.deviceId === "dev_win_1")?.allowed,
        true,
      );

      // Subsequent safe exec on allowlisted device runs directly with UTF-8 + exit code
      const okExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_win_1",
          action: "exec",
          command: "Write-Output '中文测试OK'",
        },
      });
      assert.equal(okExec.structuredContent.ok, true);
      assert.equal(okExec.structuredContent.exitCode, 0);
      assert.ok(okExec.structuredContent.output.includes("中文测试OK"));

      // Non-zero exit code propagation
      const failExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_win_1",
          action: "exec",
          command: "FAIL_CODE_7",
        },
      });
      assert.equal(failExec.structuredContent.ok, false);
      assert.equal(failExec.structuredContent.exitCode, 7);

      // Dangerous command cannot be bypassed by allowlist when skipConfirmForAllowlist=false
      const dangerExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_win_1",
          action: "exec",
          command: "rm -rf /tmp/danger",
        },
      });
      assert.equal(dangerExec.structuredContent.ok, false);
      assert.equal(dangerExec.structuredContent.pending?.dangerous, true);

      // Enabling skipConfirmForAllowlist allows allowlisted dev_win_1 without approval,
      // while non-allowlisted dev_mac_1 still queues pending
      await cMock.request("tools/call", {
        name: "app_uu_settings",
        arguments: { skipConfirmForAllowlist: true },
      });
      const skipAllowExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_win_1",
          action: "exec",
          command: "rm -rf /tmp/safe_in_mock && Write-Output '中文测试OK'",
        },
      });
      assert.equal(skipAllowExec.structuredContent.ok, true);
      assert.equal(skipAllowExec.structuredContent.pending, undefined);

      const nonAllowExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: {
          deviceId: "dev_mac_1",
          action: "exec",
          command: "echo mac",
        },
      });
      assert.equal(nonAllowExec.structuredContent.ok, false);
      assert.ok(nonAllowExec.structuredContent.pending?.id);

      // readOnly hard-denies exec & kill, allows ls & read
      await cMock.request("tools/call", {
        name: "app_uu_settings",
        arguments: { readOnly: true },
      });
      const roExec = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: { deviceId: "dev_win_1", action: "exec", command: "echo no" },
      });
      assert.equal(roExec.structuredContent.ok, false);
      assert.equal(roExec.structuredContent.pending, undefined);

      const roLs = await cMock.request("tools/call", {
        name: "uu_term",
        arguments: { deviceId: "dev_win_1", action: "ls" },
      });
      assert.equal(roLs.structuredContent.ok, true);
      assert.ok(roLs.structuredContent.sessions.length >= 1);
    } finally {
      await cMock.close();
    }

    // 3. Windows real ConPTY helper contract check
    if (process.platform === "win32") {
      assert.ok(fs.existsSync(conptyExePath), "dist/uu-conpty.exe must exist on win32");
      const conptyOut = await new Promise((resolve, reject) => {
        const p = spawn(
          conptyExePath,
          ["120", "30", "C:\\Windows\\System32\\cmd.exe", "/c", "echo", "CONPTY_BRIDGE_OK"],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        let stdout = "";
        p.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
        p.on("error", reject);
        p.on("close", () => resolve(stdout));
        setTimeout(() => p.stdin.end(), 1500);
      });
      const events = conptyOut
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.type === "ready"), "ConPTY must emit ready");
      const joinedData = events
        .filter((e) => e.type === "data")
        .map((e) => Buffer.from(e.b64, "base64").toString("utf8"))
        .join("");
      assert.ok(joinedData.includes("CONPTY_BRIDGE_OK"), "ConPTY must relay stdout");
      assert.ok(
        events.some((e) => e.type === "exit" && e.code === 0),
        "ConPTY must emit exit code 0",
      );
    }

    console.log("[UU] offline mock + policy + ConPTY verification OK");
  } finally {
    try {
      fs.rmSync(uuTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { }
  }
}

const fullCheck = process.argv.includes("--full");
const uuOnly = process.argv.includes("--uu");

if (uuOnly) {
  await runUuOfflineSuite();
} else {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-orch-test-"));
  const client = new McpTestClient(tempDataDir);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-script", version: "2.0.0" },
    });
    client.notify("notifications/initialized", {});
    assert.ok(init.capabilities.tools, "Server must advertise tools");
    assert.ok(init.capabilities.resources, "Server must advertise resources");
    console.log("[1/6] initialize OK");

    const toolsList = await client.request("tools/list", {});
    const tools = toolsList.tools;
    assert.equal(tools.length, 17, `Expected 17 tools, got ${tools.length}`);
    for (const t of tools) {
      const fullName = `mcp_ai-orchestrator_hub_${t.name}`;
      assert.ok(
        fullName.length <= 64,
        `Tool name ${fullName} exceeds 64 chars (${fullName.length})`,
      );
    }
    const resumeTool = tools.find((t) => t.name === "resume_worker");
    assert.deepEqual(resumeTool._meta?.ui?.visibility, ["model", "app"]);
    for (const reqName of [
      "uu_devices",
      "uu_term",
      "app_uu_state",
      "app_uu_act",
      "app_uu_settings",
    ]) {
      assert.ok(tools.some((t) => t.name === reqName), `Missing tool ${reqName}`);
    }
    console.log("[2/6] tools/list & <=64 char prefix checks OK (17 tools)");

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
    console.log(`[3/6] resources/read OK (${html.length} bytes HTML)`);

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
      `[4/6] codex_env OK (GPT: ${envData.quota.health} | Claude: ${envData.claude.claudeVersion} @ ${envData.claude.baseUrl})`,
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
      console.log(`[5/6] live Claude dispatch OK (${taskId})`);
    } else {
      console.log("[5/6] skipped live LLM call (pass --full to run)");
    }
  } finally {
    await client.close();
    try {
      fs.rmSync(tempDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch { }
  }

  await runUuOfflineSuite();
  console.log("[6/6] UU Remote offline & ConPTY verification OK");
}

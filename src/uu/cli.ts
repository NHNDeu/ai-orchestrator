import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { UuDeviceInfo, UuSessionInfo, UuShell } from "./types.js";

const execFileAsync = promisify(execFile);

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;
const VALID_SHELLS = new Set<UuShell>(["powershell", "cmd", "zsh", "bash"]);

export function validateDeviceId(deviceId: string): string {
  const trimmed = (deviceId || "").trim();
  if (!DEVICE_ID_RE.test(trimmed)) {
    throw new Error(`Invalid deviceId "${deviceId}"`);
  }
  return trimmed;
}

export function validateSessionName(session: string): string {
  const trimmed = (session || "").trim();
  if (!SESSION_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid session name "${session}". Use 1-48 chars of [A-Za-z0-9._-].`,
    );
  }
  return trimmed;
}

export function validateShell(shell: string | undefined, fallback: UuShell): UuShell {
  if (!shell) return fallback;
  if (VALID_SHELLS.has(shell as UuShell)) return shell as UuShell;
  throw new Error(`Unsupported shell "${shell}"`);
}

export function isJsShimPath(cliPath: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(cliPath);
}

async function queryWindowsRegistryInstDir(regKey: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", regKey, "/v", "instDir"],
      { windowsHide: true, timeout: 3000 },
    );
    const match = stdout.match(/instDir\s+REG_\w+\s+([^\r\n]+)/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export async function resolveUuCliPath(): Promise<string | null> {
  // Explicit override (including empty / non-existent in tests to simulate missing CLI)
  if (process.env.UU_CLI_PATH !== undefined) {
    const envPath = process.env.UU_CLI_PATH.trim();
    if (!envPath) return null;
    return fs.existsSync(envPath) ? envPath : null;
  }

  if (process.platform === "win32") {
    for (const regKey of [
      "HKLM\\SOFTWARE\\Netease\\GameViewerSetup",
      "HKLM\\SOFTWARE\\WOW6432Node\\Netease\\GameViewerSetup",
    ]) {
      const instDir = await queryWindowsRegistryInstDir(regKey);
      if (instDir) {
        const candidate = path.join(instDir, "bin", "uuyc-cli.exe");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    for (const candidate of [
      "C:\\Program Files\\Netease\\GameViewer\\bin\\uuyc-cli.exe",
      "C:\\Program Files (x86)\\Netease\\GameViewer\\bin\\uuyc-cli.exe",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    try {
      const { stdout } = await execFileAsync("where.exe", ["uuyc-cli"], {
        windowsHide: true,
        timeout: 3000,
      });
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch {
      // Not in PATH
    }
    return null;
  }

  if (process.platform === "darwin") {
    const macApp = "/Applications/UU远程.app/Contents/MacOS/uuyc-cli";
    if (fs.existsSync(macApp)) return macApp;
  }

  try {
    const { stdout } = await execFileAsync("which", ["uuyc-cli"], {
      timeout: 3000,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // Not in PATH
  }
  return null;
}

export interface CliExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error?: string;
}

export function parseTrailingJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to line-start JSON search
    }
  }
  const matches = Array.from(trimmed.matchAll(/(?:^|\r?\n)(\{)/g));
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const idx = (m.index ?? 0) + m[0].length - 1;
    try {
      const parsed = JSON.parse(trimmed.slice(idx));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning earlier top-level `{`
    }
  }
  return null;
}

export async function runUuCli(
  cliPath: string,
  args: string[],
  timeoutMs = 10000,
): Promise<CliExecResult> {
  const exe = isJsShimPath(cliPath) ? process.execPath : cliPath;
  const finalArgs = isJsShimPath(cliPath) ? [cliPath, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync(exe, finalArgs, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return {
      ok: true,
      exitCode: 0,
      stdout,
      stderr,
      json: parseTrailingJson(stdout),
    };
  } catch (err: unknown) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    return {
      ok: false,
      exitCode: typeof e.code === "number" ? e.code : null,
      stdout,
      stderr,
      json: parseTrailingJson(stdout),
      error: e.message || String(err),
    };
  }
}

export async function probeUuStatus(cliPath: string): Promise<{
  available: boolean;
  loggedIn: boolean;
  version: string | null;
  reason?: string;
}> {
  const res = await runUuCli(cliPath, ["status", "--json"], 8000);
  if (res.json && res.json.success && res.json.data && typeof res.json.data === "object") {
    const data = res.json.data as Record<string, unknown>;
    const loggedIn = Boolean(data.isLoggedIn);
    const version =
      typeof data.appVersion === "string" ? data.appVersion : null;
    const networkStatus =
      typeof data.networkStatus === "string" ? data.networkStatus : "";
    const serviceStatus =
      typeof data.serviceStatus === "string" ? data.serviceStatus : "";
    if (!loggedIn) {
      return {
        available: false,
        loggedIn: false,
        version,
        reason: "UU远程客户端未登录，请先在客户端登录账号。",
      };
    }
    if (serviceStatus && serviceStatus !== "running") {
      return {
        available: false,
        loggedIn,
        version,
        reason: `UU远程服务状态异常 (${serviceStatus})`,
      };
    }
    return {
      available: true,
      loggedIn: true,
      version,
      reason: networkStatus ? undefined : undefined,
    };
  }
  const errObj = res.json?.error as Record<string, unknown> | undefined;
  const errMsg =
    (typeof errObj?.message === "string" ? errObj.message : null) ||
    res.stderr.trim() ||
    res.error ||
    "无法连接 UU远程主程序（请确认客户端正在运行并已登录）";
  return {
    available: false,
    loggedIn: false,
    version: null,
    reason: errMsg,
  };
}

export async function listUuDevices(
  cliPath: string,
  allowlist: string[],
): Promise<Omit<UuDeviceInfo, "allowed">[]> {
  const res = await runUuCli(cliPath, ["device", "list", "--json"], 10000);
  if (!res.json || !res.json.success) {
    return [];
  }
  const data = res.json.data as Record<string, unknown> | undefined;
  const items = Array.isArray(data?.items) ? data.items : [];
  const out: Omit<UuDeviceInfo, "allowed">[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const deviceId = String(rec.deviceId ?? "").trim();
    if (!deviceId) continue;
    out.push({
      deviceId,
      deviceName: String(rec.deviceName ?? deviceId),
      platform: String(rec.platform ?? "Unknown"),
      isOnline: Boolean(rec.isOnline),
      lastSeen:
        typeof rec.lastSeen === "string" ? rec.lastSeen : null,
    });
  }
  void allowlist;
  return out;
}

export async function listUuSessions(
  cliPath: string,
  deviceId: string,
): Promise<{ ok: boolean; sessions: UuSessionInfo[]; error?: string }> {
  const id = validateDeviceId(deviceId);
  const res = await runUuCli(
    cliPath,
    ["term", "-d", id, "ls", "--json"],
    10000,
  );
  if (!res.json || !res.json.success) {
    const errObj = res.json?.error as Record<string, unknown> | undefined;
    return {
      ok: false,
      sessions: [],
      error:
        (typeof errObj?.message === "string" ? errObj.message : null) ||
        res.stderr.trim() ||
        res.error ||
        "查询远端终端会话失败",
    };
  }
  const data = res.json.data as Record<string, unknown> | undefined;
  const rawItems = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(res.json.data)
      ? (res.json.data as unknown[])
      : [];
  const sessions: UuSessionInfo[] = [];
  for (const raw of rawItems) {
    if (typeof raw === "string") {
      sessions.push({ name: raw });
    } else if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const name = String(r.name ?? r.sessionName ?? r.id ?? "").trim();
      if (!name) continue;
      sessions.push({
        name,
        shell: typeof r.shell === "string" ? r.shell : undefined,
        active: typeof r.active === "boolean" ? r.active : undefined,
        attached: typeof r.attached === "boolean" ? r.attached : undefined,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
      });
    }
  }
  return { ok: true, sessions };
}

export async function hasUuSession(
  cliPath: string,
  deviceId: string,
  sessionName: string,
): Promise<boolean> {
  const id = validateDeviceId(deviceId);
  const name = validateSessionName(sessionName);
  const res = await runUuCli(
    cliPath,
    ["term", "-d", id, "has", name],
    8000,
  );
  return res.ok && res.exitCode === 0;
}

export async function renameUuSession(
  cliPath: string,
  deviceId: string,
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = validateDeviceId(deviceId);
  const from = validateSessionName(oldName);
  const to = validateSessionName(newName);
  const res = await runUuCli(
    cliPath,
    ["term", "-d", id, "rename", from, to],
    8000,
  );
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: res.stderr.trim() || res.stdout.trim() || res.error || "重命名会话失败",
  };
}

export async function killUuSession(
  cliPath: string,
  deviceId: string,
  sessionName: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = validateDeviceId(deviceId);
  const name = validateSessionName(sessionName);
  const res = await runUuCli(
    cliPath,
    ["term", "-d", id, "kill", name],
    8000,
  );
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: res.stderr.trim() || res.stdout.trim() || res.error || "关闭会话失败",
  };
}

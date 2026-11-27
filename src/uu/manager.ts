import {
  listUuDevices,
  listUuSessions,
  probeUuStatus,
  resolveUuCliPath,
  validateDeviceId,
  validateSessionName,
  validateShell,
} from "./cli.js";
import { normalizeShellForDevice, UuPolicyStore } from "./policy.js";
import { UuSessionPool } from "./pool.js";
import type {
  UuConfirmMode,
  UuDeviceInfo,
  UuSessionInfo,
  UuShell,
  UuSnapshot,
  UuTermAction,
} from "./types.js";

const SNAPSHOT_CACHE_TTL_MS = 15000;
const DEFAULT_SESSION_NAME = "orch-default";

export interface UuTermToolArgs {
  deviceId: string;
  action: UuTermAction;
  session?: string;
  command?: string;
  shell?: UuShell;
  newName?: string;
  timeoutSec?: number;
  maxBytes?: number;
}

export interface UuTermToolResult {
  ok: boolean;
  action: UuTermAction;
  deviceId: string;
  session: string;
  exitCode?: number | null;
  output?: string;
  truncated?: boolean;
  remoteMayStillBeRunning?: boolean;
  sessions?: UuSessionInfo[];
  pending?: { id: string; reason: string; dangerous: boolean };
  error?: string;
}

export class UuRemoteManager {
  private policy: UuPolicyStore;
  private pool = new UuSessionPool();
  private cachedCliPath: string | null = null;
  private cachedAvailable = false;
  private cachedLoggedIn = false;
  private cachedVersion: string | null = null;
  private cachedReason: string | undefined = "尚未探测 UU远程状态";
  private cachedDevices: UuDeviceInfo[] = [];
  private cachedSessionsByDevice: Record<string, UuSessionInfo[]> = {};
  private lastRefreshedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.policy = new UuPolicyStore(dataDir);
  }

  private mapDevicesWithAllowlist(
    rawDevices: Omit<UuDeviceInfo, "allowed">[],
  ): UuDeviceInfo[] {
    return rawDevices.map((d) => ({
      ...d,
      allowed: this.policy.isAllowedDevice(d.deviceId),
    }));
  }

  private getDeviceMeta(deviceId: string): UuDeviceInfo | undefined {
    return this.cachedDevices.find((d) => d.deviceId === deviceId);
  }

  async refreshEnvironment(force = false): Promise<UuSnapshot> {
    const now = Date.now();
    if (!force && now - this.lastRefreshedAt < SNAPSHOT_CACHE_TTL_MS) {
      return this.getCachedSnapshot();
    }
    if (this.refreshPromise) {
      await this.refreshPromise;
      return this.getCachedSnapshot();
    }

    this.refreshPromise = (async () => {
      try {
        const cliPath = await resolveUuCliPath();
        this.cachedCliPath = cliPath;
        if (!cliPath) {
          this.cachedAvailable = false;
          this.cachedLoggedIn = false;
          this.cachedVersion = null;
          this.cachedReason =
            "未检测到 uuyc-cli（请确认已安装网易UU远程，或设置环境变量 UU_CLI_PATH）";
          this.cachedDevices = [];
          this.lastRefreshedAt = Date.now();
          return;
        }

        const status = await probeUuStatus(cliPath);
        this.cachedAvailable = status.available;
        this.cachedLoggedIn = status.loggedIn;
        this.cachedVersion = status.version;
        this.cachedReason = status.reason;

        if (status.available) {
          const raw = await listUuDevices(
            cliPath,
            this.policy.getSettings().allowlist,
          );
          this.cachedDevices = this.mapDevicesWithAllowlist(raw);
        } else {
          this.cachedDevices = [];
        }
        this.lastRefreshedAt = Date.now();
      } catch (err) {
        this.cachedAvailable = false;
        this.cachedReason = err instanceof Error ? err.message : String(err);
        this.lastRefreshedAt = Date.now();
      } finally {
        this.refreshPromise = null;
      }
    })();

    await this.refreshPromise;
    return this.getCachedSnapshot();
  }

  /**
   * Synchronous non-blocking snapshot getter for Dashboard `app_state` polling.
   * Triggers a background refresh if cache is stale.
   */
  getCachedSnapshot(): UuSnapshot {
    if (
      Date.now() - this.lastRefreshedAt >= SNAPSHOT_CACHE_TTL_MS &&
      !this.refreshPromise
    ) {
      void this.refreshEnvironment(false);
    }

    const devices = this.cachedDevices.map((d) => ({
      ...d,
      allowed: this.policy.isAllowedDevice(d.deviceId),
    }));

    return {
      available: this.cachedAvailable,
      loggedIn: this.cachedLoggedIn,
      cliPath: this.cachedCliPath,
      version: this.cachedVersion,
      reason: this.cachedReason,
      lastRefreshedAt: this.lastRefreshedAt,
      settings: this.policy.getSettings(),
      devices,
      sessionsByDevice: { ...this.cachedSessionsByDevice },
      pending: this.policy.getPending(),
      audit: this.policy.getRecentAudit(),
    };
  }

  private async ensureCliReady(): Promise<
    { ok: true; cliPath: string } | { ok: false; error: string }
  > {
    if (
      !this.cachedCliPath ||
      !this.cachedAvailable ||
      Date.now() - this.lastRefreshedAt > SNAPSHOT_CACHE_TTL_MS
    ) {
      await this.refreshEnvironment(false);
    }
    if (!this.cachedCliPath || !this.cachedAvailable) {
      return {
        ok: false,
        error:
          this.cachedReason || "UU远程不可用，请确认客户端已启动并登录。",
      };
    }
    return { ok: true, cliPath: this.cachedCliPath };
  }

  private async refreshDeviceSessions(
    cliPath: string,
    deviceId: string,
  ): Promise<UuSessionInfo[]> {
    const res = await listUuSessions(cliPath, deviceId);
    if (res.ok) {
      const localActive = new Set(this.pool.getActiveSessionNames(deviceId));
      const merged = res.sessions.map((s) => ({
        ...s,
        managed: localActive.has(s.name),
      }));
      this.cachedSessionsByDevice[deviceId] = merged;
      return merged;
    }
    return this.cachedSessionsByDevice[deviceId] ?? [];
  }

  private async executeCoreAction(
    source: "model" | "app",
    cliPath: string,
    args: UuTermToolArgs,
    decisionTag: "allowed" | "approved",
  ): Promise<UuTermToolResult> {
    const deviceId = validateDeviceId(args.deviceId);
    const dev = this.getDeviceMeta(deviceId);
    const deviceName = dev?.deviceName || deviceId;
    const platform = dev?.platform || "Windows";
    const sessionName = validateSessionName(
      args.session || DEFAULT_SESSION_NAME,
    );
    const shell = validateShell(
      args.shell,
      normalizeShellForDevice(undefined, platform),
    );
    const startMs = Date.now();

    if (args.action === "ls") {
      const res = await listUuSessions(cliPath, deviceId);
      if (res.ok) {
        const localActive = new Set(this.pool.getActiveSessionNames(deviceId));
        const sessions = res.sessions.map((s) => ({
          ...s,
          managed: localActive.has(s.name),
        }));
        this.cachedSessionsByDevice[deviceId] = sessions;
        return {
          ok: true,
          action: "ls",
          deviceId,
          session: sessionName,
          sessions,
        };
      }
      return {
        ok: false,
        action: "ls",
        deviceId,
        session: sessionName,
        error: res.error,
      };
    }

    if (args.action === "read") {
      const ring = this.pool.readRing(
        deviceId,
        sessionName,
        args.maxBytes ?? 16384,
      );
      if (!ring.connected) {
        return {
          ok: true,
          action: "read",
          deviceId,
          session: sessionName,
          output: "(该会话尚未在本插件本地挂载；请先执行 new 或 exec)",
          truncated: false,
        };
      }
      return {
        ok: true,
        action: "read",
        deviceId,
        session: sessionName,
        output: ring.output,
        truncated: ring.truncated,
      };
    }

    if (args.action === "new") {
      const opened = await this.pool.ensureSession(
        cliPath,
        deviceId,
        sessionName,
        shell,
      );
      await this.refreshDeviceSessions(cliPath, deviceId);
      this.policy.recordAudit({
        source,
        deviceId,
        deviceName,
        action: "new",
        session: sessionName,
        decision: opened.ok ? decisionTag : "failed",
        reason: opened.ok ? `shell=${shell}` : opened.error,
        durationMs: Date.now() - startMs,
      });
      return {
        ok: opened.ok,
        action: "new",
        deviceId,
        session: sessionName,
        output: opened.ok ? `会话 ${sessionName} (${shell}) 已就绪` : undefined,
        error: opened.error,
      };
    }

    if (args.action === "kill") {
      const killed = await this.pool.killSession(cliPath, deviceId, sessionName);
      await this.refreshDeviceSessions(cliPath, deviceId);
      this.policy.recordAudit({
        source,
        deviceId,
        deviceName,
        action: "kill",
        session: sessionName,
        decision: killed.ok ? decisionTag : "failed",
        reason: killed.error,
        durationMs: Date.now() - startMs,
      });
      return {
        ok: killed.ok,
        action: "kill",
        deviceId,
        session: sessionName,
        output: killed.ok ? `已终止会话 ${sessionName}` : undefined,
        error: killed.error,
      };
    }

    if (args.action === "rename") {
      if (!args.newName) {
        return {
          ok: false,
          action: "rename",
          deviceId,
          session: sessionName,
          error: "rename 操作需要提供 newName 参数",
        };
      }
      const renamed = await this.pool.renameSession(
        cliPath,
        deviceId,
        sessionName,
        args.newName,
      );
      await this.refreshDeviceSessions(cliPath, deviceId);
      this.policy.recordAudit({
        source,
        deviceId,
        deviceName,
        action: "rename",
        session: `${sessionName} -> ${args.newName}`,
        decision: renamed.ok ? decisionTag : "failed",
        reason: renamed.error,
        durationMs: Date.now() - startMs,
      });
      return {
        ok: renamed.ok,
        action: "rename",
        deviceId,
        session: args.newName,
        output: renamed.ok
          ? `会话已重命名为 ${args.newName}`
          : undefined,
        error: renamed.error,
      };
    }

    // exec
    const command = args.command ?? "";
    if (!command.trim()) {
      return {
        ok: false,
        action: "exec",
        deviceId,
        session: sessionName,
        error: "exec 操作需要提供非空 command",
      };
    }

    const res = await this.pool.exec(
      cliPath,
      deviceId,
      sessionName,
      shell,
      command,
      args.timeoutSec ?? 60,
      args.maxBytes ?? 32768,
    );
    await this.refreshDeviceSessions(cliPath, deviceId);
    this.policy.recordAudit({
      source,
      deviceId,
      deviceName,
      action: "exec",
      session: sessionName,
      command,
      decision:
        res.status === "timeout"
          ? "timeout"
          : res.status === "completed"
            ? decisionTag
            : "failed",
      exitCode: res.exitCode,
      outputPreview: res.output || res.error,
      reason: res.error,
      durationMs: Date.now() - startMs,
    });

    return {
      ok: res.ok,
      action: "exec",
      deviceId,
      session: sessionName,
      exitCode: res.exitCode,
      output: res.output,
      truncated: res.truncated,
      remoteMayStillBeRunning: res.remoteMayStillBeRunning,
      error: res.error,
    };
  }

  async handleModelTerm(args: UuTermToolArgs): Promise<UuTermToolResult> {
    let deviceId: string;
    let sessionName: string;
    try {
      deviceId = validateDeviceId(args.deviceId);
      sessionName = validateSessionName(args.session || DEFAULT_SESSION_NAME);
    } catch (err) {
      return {
        ok: false,
        action: args.action,
        deviceId: args.deviceId,
        session: args.session || DEFAULT_SESSION_NAME,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const dev = this.getDeviceMeta(deviceId);
    const deviceName = dev?.deviceName || deviceId;
    const platform = dev?.platform || "Windows";
    const shell = validateShell(
      args.shell,
      normalizeShellForDevice(undefined, platform),
    );

    const policyRes = this.policy.evaluateModelAccess({
      deviceId,
      action: args.action,
      command: args.command,
    });

    if (policyRes.decision === "denied") {
      this.policy.recordAudit({
        source: "model",
        deviceId,
        deviceName,
        action: args.action,
        session: sessionName,
        command: args.command,
        decision: "denied",
        reason: policyRes.reason,
      });
      return {
        ok: false,
        action: args.action,
        deviceId,
        session: sessionName,
        error: policyRes.reason,
      };
    }

    if (policyRes.decision === "pending") {
      const pending = this.policy.enqueuePending({
        deviceId,
        deviceName,
        action: args.action,
        session: sessionName,
        shell,
        command: args.command,
        newName: args.newName,
        reason: policyRes.reason,
        dangerous: policyRes.dangerous,
      });
      this.policy.recordAudit({
        source: "model",
        deviceId,
        deviceName,
        action: args.action,
        session: sessionName,
        command: args.command,
        decision: "pending",
        reason: policyRes.reason,
      });
      return {
        ok: false,
        action: args.action,
        deviceId,
        session: sessionName,
        pending: {
          id: pending.id,
          reason: pending.reason,
          dangerous: pending.dangerous,
        },
        error: `操作已进入待审批队列 (${pending.id})：${pending.reason}。请提示用户在 AI Orchestrator 看板的「远程」面板点击批准，批准后再通过 read 或 ls 查看结果（不要重复提交同一指令）。`,
      };
    }

    const ready = await this.ensureCliReady();
    if (!ready.ok) {
      return {
        ok: false,
        action: args.action,
        deviceId,
        session: sessionName,
        error: ready.error,
      };
    }

    return this.executeCoreAction(
      "model",
      ready.cliPath,
      { ...args, deviceId, session: sessionName, shell },
      "allowed",
    );
  }

  async handleAppAct(params: {
    op:
      | "refresh"
      | "new"
      | "exec"
      | "kill"
      | "rename"
      | "approve"
      | "reject"
      | "toggle_allow";
    deviceId?: string;
    session?: string;
    command?: string;
    shell?: UuShell;
    newName?: string;
    pendingId?: string;
    alsoAllowDevice?: boolean;
  }): Promise<{ ok: boolean; message: string; snapshot: UuSnapshot }> {
    if (params.op === "refresh") {
      await this.refreshEnvironment(true);
      if (params.deviceId && this.cachedCliPath && this.cachedAvailable) {
        try {
          await this.refreshDeviceSessions(
            this.cachedCliPath,
            validateDeviceId(params.deviceId),
          );
        } catch { }
      }
      return {
        ok: true,
        message: "已刷新 UU 远程状态",
        snapshot: this.getCachedSnapshot(),
      };
    }

    if (params.op === "toggle_allow") {
      if (!params.deviceId) {
        return {
          ok: false,
          message: "缺少 deviceId",
          snapshot: this.getCachedSnapshot(),
        };
      }
      const id = validateDeviceId(params.deviceId);
      if (this.policy.isAllowedDevice(id)) {
        this.policy.removeFromAllowlist(id);
      } else {
        this.policy.addToAllowlist(id);
      }
      return {
        ok: true,
        message: "已更新设备白名单",
        snapshot: this.getCachedSnapshot(),
      };
    }

    if (params.op === "reject") {
      if (!params.pendingId) {
        return {
          ok: false,
          message: "缺少 pendingId",
          snapshot: this.getCachedSnapshot(),
        };
      }
      const item = this.policy.resolvePending(params.pendingId, "rejected");
      if (item) {
        this.policy.recordAudit({
          source: "app",
          deviceId: item.deviceId,
          deviceName: item.deviceName,
          action: item.action,
          session: item.session,
          command: item.command,
          decision: "rejected",
          reason: "用户在 Dashboard 拒绝执行",
        });
      }
      return {
        ok: Boolean(item),
        message: item ? "已拒绝待审批请求" : "待审批请求不存在或已处理",
        snapshot: this.getCachedSnapshot(),
      };
    }

    if (params.op === "approve") {
      if (!params.pendingId) {
        return {
          ok: false,
          message: "缺少 pendingId",
          snapshot: this.getCachedSnapshot(),
        };
      }
      const item = this.policy.resolvePending(params.pendingId, "approved");
      if (!item) {
        return {
          ok: false,
          message: "待审批请求不存在或已处理",
          snapshot: this.getCachedSnapshot(),
        };
      }
      if (params.alsoAllowDevice && !item.dangerous) {
        this.policy.addToAllowlist(item.deviceId);
      }
      const ready = await this.ensureCliReady();
      if (!ready.ok) {
        return {
          ok: false,
          message: ready.error,
          snapshot: this.getCachedSnapshot(),
        };
      }
      const res = await this.executeCoreAction(
        "app",
        ready.cliPath,
        {
          deviceId: item.deviceId,
          action: item.action,
          session: item.session,
          shell: item.shell,
          command: item.command,
          newName: item.newName,
        },
        "approved",
      );
      return {
        ok: res.ok,
        message: res.ok
          ? `已批准并执行完成 (exit=${res.exitCode ?? 0})`
          : res.error || "执行失败",
        snapshot: this.getCachedSnapshot(),
      };
    }

    // Direct UI actions (new, exec, kill, rename)
    if (!params.deviceId) {
      return {
        ok: false,
        message: "缺少 deviceId",
        snapshot: this.getCachedSnapshot(),
      };
    }
    if (
      this.policy.getSettings().readOnly &&
      (params.op === "exec" ||
        params.op === "new" ||
        params.op === "kill" ||
        params.op === "rename")
    ) {
      return {
        ok: false,
        message: "当前处于只读模式，请先关闭只读开关再执行写操作",
        snapshot: this.getCachedSnapshot(),
      };
    }

    const ready = await this.ensureCliReady();
    if (!ready.ok) {
      return {
        ok: false,
        message: ready.error,
        snapshot: this.getCachedSnapshot(),
      };
    }

    const res = await this.executeCoreAction(
      "app",
      ready.cliPath,
      {
        deviceId: params.deviceId,
        action: params.op,
        session: params.session,
        shell: params.shell,
        command: params.command,
        newName: params.newName,
      },
      "allowed",
    );

    return {
      ok: res.ok,
      message: res.ok ? res.output || "操作完成" : res.error || "操作失败",
      snapshot: this.getCachedSnapshot(),
    };
  }

  handleAppSettings(patch: {
    enabled?: boolean;
    readOnly?: boolean;
    allowlist?: string[];
    confirmMode?: UuConfirmMode;
    skipConfirmForAllowlist?: boolean;
    denyPatterns?: string[];
  }): UuSnapshot {
    this.policy.updateSettings(patch);
    return this.getCachedSnapshot();
  }

  shutdown(): void {
    this.pool.shutdown();
  }
}

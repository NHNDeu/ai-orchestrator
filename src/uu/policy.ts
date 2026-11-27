import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  UuAuditEntry,
  UuConfirmMode,
  UuPendingRequest,
  UuSettings,
  UuShell,
  UuTermAction,
} from "./types.js";

const DEFAULT_DENY_PATTERNS: string[] = [
  "\\brm\\s+-[a-zA-Z]*[rf][a-zA-Z]*\\s+(/|~|\\$HOME|C:\\\\)",
  "\\brm\\s+-rf\\b",
  "\\bRemove-Item\\b.*-Recurse",
  "\\b(format|mkfs|fdisk|diskpart)\\b",
  "\\bdel\\s+/[sSqQ]",
  "\\b(shutdown|reboot|Stop-Computer|Restart-Computer)\\b",
  "\\breg\\s+delete\\b",
  "\\bdd\\s+if=.*\\bof=/dev/",
  "(curl|wget)\\b.*\\|\\s*(ba|z)?sh\\b",
  "Invoke-Expression|\\biex\\b",
];

const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_STORED = 50;
const MAX_AUDIT_IN_MEMORY = 80;

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export interface PolicyDecision {
  decision: "allowed" | "pending" | "denied";
  reason: string;
  dangerous: boolean;
}

export class UuPolicyStore {
  private configPath: string;
  private pendingPath: string;
  private auditPath: string;
  private settings: UuSettings;
  private pending: UuPendingRequest[] = [];
  private recentAudit: UuAuditEntry[] = [];

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, "uu-config.json");
    this.pendingPath = path.join(dataDir, "uu-pending.json");
    this.auditPath = path.join(dataDir, "uu-audit.jsonl");

    this.settings = {
      enabled: false,
      readOnly: false,
      allowlist: [],
      confirmMode: "allowlist",
      skipConfirmForAllowlist: false,
      denyPatterns: [...DEFAULT_DENY_PATTERNS],
    };

    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(
          fs.readFileSync(this.configPath, "utf8"),
        ) as Partial<UuSettings>;
        this.settings = {
          enabled:
            typeof raw.enabled === "boolean"
              ? raw.enabled
              : this.settings.enabled,
          readOnly:
            typeof raw.readOnly === "boolean"
              ? raw.readOnly
              : this.settings.readOnly,
          allowlist: Array.isArray(raw.allowlist)
            ? raw.allowlist.map((s) => String(s).trim()).filter(Boolean)
            : [],
          confirmMode:
            raw.confirmMode === "always" ||
            raw.confirmMode === "off" ||
            raw.confirmMode === "allowlist"
              ? raw.confirmMode
              : "allowlist",
          skipConfirmForAllowlist:
            typeof raw.skipConfirmForAllowlist === "boolean"
              ? raw.skipConfirmForAllowlist
              : this.settings.skipConfirmForAllowlist,
          denyPatterns: Array.isArray(raw.denyPatterns)
            ? raw.denyPatterns.map((s) => String(s)).filter(Boolean)
            : [...DEFAULT_DENY_PATTERNS],
        };
      }
    } catch {
      // Keep safe defaults
    }

    try {
      if (fs.existsSync(this.pendingPath)) {
        const raw = JSON.parse(
          fs.readFileSync(this.pendingPath, "utf8"),
        ) as UuPendingRequest[];
        if (Array.isArray(raw)) {
          this.pending = raw
            .filter((p) => p && p.status === "pending")
            .slice(-MAX_PENDING_STORED);
        }
      }
    } catch {
      this.pending = [];
    }

    try {
      if (fs.existsSync(this.auditPath)) {
        const lines = fs
          .readFileSync(this.auditPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim());
        const tail = lines.slice(-MAX_AUDIT_IN_MEMORY);
        const parsed: UuAuditEntry[] = [];
        for (const l of tail) {
          try {
            parsed.push(JSON.parse(l) as UuAuditEntry);
          } catch {
            // Skip malformed line
          }
        }
        this.recentAudit = parsed.reverse();
      }
    } catch {
      this.recentAudit = [];
    }
  }

  getSettings(): UuSettings {
    return {
      ...this.settings,
      allowlist: [...this.settings.allowlist],
      denyPatterns: [...this.settings.denyPatterns],
    };
  }

  updateSettings(patch: {
    enabled?: boolean;
    readOnly?: boolean;
    allowlist?: string[];
    confirmMode?: UuConfirmMode;
    skipConfirmForAllowlist?: boolean;
    denyPatterns?: string[];
  }): UuSettings {
    if (typeof patch.enabled === "boolean") {
      this.settings.enabled = patch.enabled;
    }
    if (typeof patch.readOnly === "boolean") {
      this.settings.readOnly = patch.readOnly;
    }
    if (Array.isArray(patch.allowlist)) {
      this.settings.allowlist = Array.from(
        new Set(patch.allowlist.map((s) => String(s).trim()).filter(Boolean)),
      );
    }
    if (
      patch.confirmMode === "allowlist" ||
      patch.confirmMode === "always" ||
      patch.confirmMode === "off"
    ) {
      this.settings.confirmMode = patch.confirmMode;
    }
    if (typeof patch.skipConfirmForAllowlist === "boolean") {
      this.settings.skipConfirmForAllowlist = patch.skipConfirmForAllowlist;
    }
    if (Array.isArray(patch.denyPatterns)) {
      this.settings.denyPatterns = patch.denyPatterns
        .map((s) => String(s))
        .filter(Boolean);
    }
    try {
      writeJsonAtomic(this.configPath, this.settings);
    } catch {
      // Ignore write error
    }
    return this.getSettings();
  }

  addToAllowlist(deviceId: string): UuSettings {
    if (!this.settings.allowlist.includes(deviceId)) {
      return this.updateSettings({
        allowlist: [...this.settings.allowlist, deviceId],
      });
    }
    return this.getSettings();
  }

  removeFromAllowlist(deviceId: string): UuSettings {
    return this.updateSettings({
      allowlist: this.settings.allowlist.filter((id) => id !== deviceId),
    });
  }

  isAllowedDevice(deviceId: string): boolean {
    return this.settings.allowlist.includes(deviceId);
  }

  private matchesDangerousPattern(command: string): string | null {
    for (const pat of this.settings.denyPatterns) {
      try {
        const re = new RegExp(pat, "i");
        if (re.test(command)) return pat;
      } catch {
        // Ignore invalid user regex
      }
    }
    return null;
  }

  evaluateModelAccess(params: {
    deviceId: string;
    action: UuTermAction;
    command?: string;
  }): PolicyDecision {
    if (!this.settings.enabled) {
      return {
        decision: "denied",
        reason:
          "UU远程功能未启用。请在 AI Orchestrator 右侧面板切换到「远程」标签开启总开关。",
        dangerous: false,
      };
    }

    const isReadAction =
      params.action === "ls" || params.action === "read";

    if (this.settings.readOnly && !isReadAction) {
      return {
        decision: "denied",
        reason: `当前处于只读模式（readOnly=true），已拒绝写操作 "${params.action}"。`,
        dangerous: false,
      };
    }

    if (isReadAction) {
      return {
        decision: "allowed",
        reason: "只读查询放行",
        dangerous: false,
      };
    }

    if (
      this.settings.skipConfirmForAllowlist &&
      this.isAllowedDevice(params.deviceId)
    ) {
      return {
        decision: "allowed",
        reason: "白名单设备免审批",
        dangerous: false,
      };
    }

    if (params.action === "exec" && params.command) {
      const hit = this.matchesDangerousPattern(params.command);
      if (hit) {
        return {
          decision: "pending",
          reason: `命中高危命令规则 (${hit})，必须由用户在 Dashboard「远程」面板手动批准`,
          dangerous: true,
        };
      }
    }

    if (this.settings.confirmMode === "always") {
      return {
        decision: "pending",
        reason: "当前策略要求每次写操作在面板确认 (confirmMode=always)",
        dangerous: false,
      };
    }

    if (
      this.settings.confirmMode === "allowlist" &&
      !this.isAllowedDevice(params.deviceId)
    ) {
      return {
        decision: "pending",
        reason: `设备 ${params.deviceId} 不在白名单中，请在 Dashboard「远程」面板确认授权`,
        dangerous: false,
      };
    }

    return {
      decision: "allowed",
      reason: "已授权",
      dangerous: false,
    };
  }

  enqueuePending(req: Omit<UuPendingRequest, "id" | "ts" | "status">): UuPendingRequest {
    const item: UuPendingRequest = {
      ...req,
      id: `uup_${crypto.randomBytes(4).toString("hex")}`,
      ts: Date.now(),
      status: "pending",
    };
    this.pending.unshift(item);
    if (this.pending.length > MAX_PENDING_STORED) {
      this.pending = this.pending.slice(0, MAX_PENDING_STORED);
    }
    this.savePending();
    return item;
  }

  getPending(): UuPendingRequest[] {
    return this.pending.filter((p) => p.status === "pending");
  }

  resolvePending(
    pendingId: string,
    status: "approved" | "rejected",
  ): UuPendingRequest | null {
    const idx = this.pending.findIndex(
      (p) => p.id === pendingId && p.status === "pending",
    );
    if (idx === -1) return null;
    const item = { ...this.pending[idx], status };
    this.pending.splice(idx, 1);
    this.savePending();
    return item;
  }

  private savePending(): void {
    try {
      writeJsonAtomic(this.pendingPath, this.pending);
    } catch {
      // Ignore persistence error
    }
  }

  recordAudit(entry: Omit<UuAuditEntry, "id" | "ts">): UuAuditEntry {
    const full: UuAuditEntry = {
      ...entry,
      id: `uua_${crypto.randomBytes(4).toString("hex")}`,
      ts: Date.now(),
      outputPreview: entry.outputPreview
        ? entry.outputPreview.slice(0, 512)
        : undefined,
    };
    this.recentAudit.unshift(full);
    if (this.recentAudit.length > MAX_AUDIT_IN_MEMORY) {
      this.recentAudit = this.recentAudit.slice(0, MAX_AUDIT_IN_MEMORY);
    }
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      if (fs.existsSync(this.auditPath)) {
        const stat = fs.statSync(this.auditPath);
        if (stat.size >= MAX_AUDIT_FILE_BYTES) {
          const rotated = `${this.auditPath}.1`;
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(this.auditPath, rotated);
        }
      }
      fs.appendFileSync(this.auditPath, `${JSON.stringify(full)}\n`, "utf8");
    } catch {
      // Ignore audit disk write errors
    }
    return full;
  }

  getRecentAudit(): UuAuditEntry[] {
    return [...this.recentAudit];
  }
}

export function normalizeShellForDevice(
  requested: UuShell | undefined,
  platform: string,
): UuShell {
  if (requested) return requested;
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("darwin")) return "zsh";
  if (p.includes("linux")) return "bash";
  return "powershell";
}

export type UuShell = "powershell" | "cmd" | "zsh" | "bash";
export type UuConfirmMode = "allowlist" | "always" | "off";
export type UuTermAction = "ls" | "new" | "exec" | "read" | "kill" | "rename";
export type UuAuditDecision =
  | "allowed"
  | "pending"
  | "approved"
  | "rejected"
  | "denied"
  | "failed"
  | "timeout";

export interface UuDeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  isOnline: boolean;
  lastSeen: string | null;
  allowed: boolean;
}

export interface UuSessionInfo {
  name: string;
  shell?: string;
  active?: boolean;
  attached?: boolean;
  createdAt?: string | null;
  managed?: boolean;
}

export interface UuSettings {
  enabled: boolean;
  readOnly: boolean;
  allowlist: string[];
  confirmMode: UuConfirmMode;
  skipConfirmForAllowlist: boolean;
  denyPatterns: string[];
}

export interface UuPendingRequest {
  id: string;
  ts: number;
  deviceId: string;
  deviceName: string;
  action: UuTermAction;
  session: string;
  shell: UuShell;
  command?: string;
  newName?: string;
  reason: string;
  dangerous: boolean;
  status: "pending" | "approved" | "rejected";
}

export interface UuAuditEntry {
  id: string;
  ts: number;
  source: "model" | "app";
  deviceId: string;
  deviceName: string;
  action: UuTermAction;
  session?: string;
  command?: string;
  decision: UuAuditDecision;
  reason?: string;
  exitCode?: number | null;
  outputPreview?: string;
  durationMs?: number;
}

export interface UuExecResult {
  ok: boolean;
  status: "completed" | "timeout" | "disconnected" | "error";
  exitCode: number | null;
  output: string;
  truncated: boolean;
  remoteMayStillBeRunning?: boolean;
  error?: string;
}

export interface UuSnapshot {
  available: boolean;
  loggedIn: boolean;
  cliPath: string | null;
  version: string | null;
  reason?: string;
  lastRefreshedAt: number;
  settings: UuSettings;
  devices: UuDeviceInfo[];
  sessionsByDevice: Record<string, UuSessionInfo[]>;
  pending: UuPendingRequest[];
  audit: UuAuditEntry[];
}

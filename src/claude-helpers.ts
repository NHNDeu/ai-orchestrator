import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelInfo {
  slug: string;
  displayName: string;
  defaultEffort: string;
  supportedEfforts: string[];
  engine?: "codex" | "claude";
}

export interface ClaudeEnvironmentInfo {
  claudePath: string | null;
  claudeVersion: string | null;
  configured: boolean;
  baseUrl: string | null;
  models: {
    fast: string;
    balanced: string;
    deep: string;
  };
  availableModels: ModelInfo[];
  dailyCostUsd: number;
  dailyBudgetUsd: number;
  maxTaskBudgetUsd: number;
  cooldownUntil: number | null;
  canAutoUse: boolean;
  summary: string;
}

export interface ClaudeSettingsSnapshot {
  configured: boolean;
  baseUrl: string | null;
  fastModel: string;
  balancedModel: string;
  deepModel: string;
  availableModels: ModelInfo[];
}

export function claudeHomeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function resolveClaudeBinary(): string | null {
  if (
    process.env.CLAUDE_CLI_PATH &&
    fs.existsSync(process.env.CLAUDE_CLI_PATH)
  ) {
    return process.env.CLAUDE_CLI_PATH;
  }

  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const npmNativeExe = path.join(
    appData,
    "npm",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (fs.existsSync(npmNativeExe)) {
    return npmNativeExe;
  }

  const localExe = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (fs.existsSync(localExe)) {
    return localExe;
  }

  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude"]
      : ["claude"]) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }

  return null;
}

export function loadClaudeConfig(): ClaudeSettingsSnapshot {
  const settingsPath = path.join(claudeHomeDir(), "settings.json");
  const credentialsPath = path.join(claudeHomeDir(), ".credentials.json");
  let baseUrl: string | null = process.env.ANTHROPIC_BASE_URL || null;
  let hasToken = Boolean(
    process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      fs.existsSync(credentialsPath),
  );
  let haikuRaw = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "";
  let sonnetRaw = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "";
  let opusRaw =
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    "";

  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
        env?: Record<string, string>;
      };
      const env = parsed.env ?? {};
      if (env.ANTHROPIC_BASE_URL) baseUrl = env.ANTHROPIC_BASE_URL;
      if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) hasToken = true;
      if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
        haikuRaw = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      }
      if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
        sonnetRaw = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      }
      if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
        opusRaw = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      } else if (env.ANTHROPIC_MODEL && !opusRaw) {
        opusRaw = env.ANTHROPIC_MODEL;
      }
    } catch {
      // Ignore corrupt settings.json
    }
  }

  const balancedModel = sonnetRaw || "claude-sonnet-5-5";
  const deepModel = opusRaw || "claude-opus-5-5";
  // claude-fable-5-1 is disabled on some relays (HTTP 403); default fast to balancedModel
  const fastModel =
    haikuRaw && haikuRaw !== "claude-fable-5-1" ? haikuRaw : balancedModel;

  const seen = new Set<string>();
  const availableModels: ModelInfo[] = [];
  for (const [slug, label, defEffort] of [
    [balancedModel, `${balancedModel} (均衡)`, "medium"],
    [deepModel, `${deepModel} (深度)`, "high"],
    ...(fastModel !== balancedModel
      ? [[fastModel, `${fastModel} (轻量)`, "low"] as const]
      : []),
  ]) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    availableModels.push({
      slug,
      displayName: label,
      defaultEffort: defEffort,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      engine: "claude",
    });
  }

  return {
    configured: hasToken || Boolean(baseUrl),
    baseUrl,
    fastModel,
    balancedModel,
    deepModel,
    availableModels,
  };
}

export function isTodayLocal(ts?: number): boolean {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

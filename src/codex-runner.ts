import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isTodayLocal,
  loadClaudeConfig,
  resolveClaudeBinary,
  type ClaudeEnvironmentInfo,
  type ModelInfo,
} from "./claude-helpers.js";

export type { ClaudeEnvironmentInfo, ModelInfo } from "./claude-helpers.js";

const execFileAsync = promisify(execFile);

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskEngine = "codex" | "claude";
export type RoutingStrategy =
  | "cost-smart"
  | "quality-first"
  | "codex-only"
  | "claude-only";

export type TaskMode = "read-only" | "workspace-write" | "review";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type StepStatus = "pending" | "active" | "done";

export interface TaskStep {
  label: string;
  status: StepStatus;
}

export interface TaskLogEntry {
  ts: number;
  kind: "info" | "reasoning" | "command" | "file" | "message" | "error";
  text: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type QuotaHealth =
  | "abundant"
  | "moderate"
  | "low"
  | "exhausted"
  | "unknown";

export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  resetPassed: boolean;
}

export interface CodexQuotaInfo {
  available: boolean;
  planType: string | null;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  effectiveRemainingPct: number | null;
  health: QuotaHealth;
  canAutoUse: boolean;
  recommendedMaxConcurrency: number;
  recommendedMaxEffort: ReasoningEffort;
  hasExtraCredits: boolean;
  sampledAt: number | null;
  cooldownUntil: number | null;
  summary: string;
}

export interface CodexTask {
  id: string;
  batchId: string;
  batchTitle?: string;
  engine: TaskEngine;
  name: string;
  role: string;
  prompt: string;
  cwd: string;
  mode: TaskMode;
  worktree: boolean;
  model: string;
  effort: ReasoningEffort;
  autoRouted?: boolean;
  routeReason?: string;
  steps: TaskStep[];
  status: TaskStatus;
  progress: number;
  phase: string;
  threadId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  retryCount: number;
  timeoutSec: number;
  costUsd?: number;
  usage: TokenUsage;
  changedFiles: string[];
  logs: TaskLogEntry[];
  finalMessage?: string;
  error?: string;
}

export interface OrchestratorSettings {
  maxConcurrency: number;
  defaultModel: string;
  defaultEffort: ReasoningEffort;
  defaultTimeoutSec: number;
  autoRetryOnRateLimit: boolean;
  autoOrchestrate: boolean;
  routingStrategy: RoutingStrategy;
  claudeDailyBudgetUsd: number;
  claudeMaxTaskBudgetUsd: number;
  autoFallback: boolean;
}

export interface CodexEnvironmentInfo {
  codexPath: string | null;
  codexVersion: string | null;
  loggedIn: boolean;
  loginMessage: string;
  models: ModelInfo[];
  defaultModel: string;
  defaultEffort: ReasoningEffort;
  quota: CodexQuotaInfo;
  claude: ClaudeEnvironmentInfo;
}

export interface DispatchTaskInput {
  name: string;
  prompt: string;
  engine?: "auto" | TaskEngine;
  role?: string;
  cwd?: string;
  mode?: TaskMode;
  worktree?: boolean;
  model?: string;
  effort?: "auto" | ReasoningEffort;
  preset?: "fast" | "balanced" | "deep";
  steps?: string[];
  timeoutSec?: number;
}

export interface DashboardSnapshot {
  environment: {
    codexPath: string | null;
    codexVersion: string | null;
    loggedIn: boolean;
    loginMessage: string;
    models: ModelInfo[];
    quota: CodexQuotaInfo;
    claude: ClaudeEnvironmentInfo;
  };
  settings: OrchestratorSettings;
  summary: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    overallProgress: number;
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  };
  tasks: CodexTask[];
  serverTime: number;
}

interface PersistedState {
  settings?: Partial<OrchestratorSettings>;
  tasks?: CodexTask[];
}

const MAX_TASKS_STORED = 50;
const MAX_LOGS_PER_TASK = 80;
const MAX_FINAL_MSG_IN_SNAPSHOT = 12000;

function codexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function parseVersionTuple(text: string): number[] {
  const m = text.match(/(\d+(?:\.\d+)+)/);
  if (!m) return [0];
  return m[1].split(".").map((n) => parseInt(n, 10) || 0);
}

function compareVersionsDesc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    if (va !== vb) return vb - va;
  }
  return 0;
}

function readCodexTomlDefaults(): {
  codexCliPath?: string;
  model?: string;
  effort?: string;
} {
  const tomlPath = path.join(codexHomeDir(), "config.toml");
  if (!fs.existsSync(tomlPath)) return {};
  try {
    const raw = fs.readFileSync(tomlPath, "utf8");
    const modelMatch = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const effortMatch = raw.match(
      /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m,
    );
    const cliMatch = raw.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/);
    return {
      codexCliPath: cliMatch?.[1]?.replace(/\\\\/g, "\\"),
      model: modelMatch?.[1],
      effort: effortMatch?.[1],
    };
  } catch {
    return {};
  }
}

export function loadAvailableModels(): {
  models: ModelInfo[];
  defaultModel: string;
  defaultEffort: ReasoningEffort;
} {
  const defaults = readCodexTomlDefaults();
  const cachePath = path.join(codexHomeDir(), "models_cache.json");
  const models: ModelInfo[] = [];

  if (fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          visibility?: string;
          default_reasoning_level?: string;
          supported_reasoning_levels?: Array<{ effort?: string }>;
        }>;
      };
      for (const m of parsed.models ?? []) {
        if (!m.slug) continue;
        if (m.visibility && m.visibility !== "list") continue;
        models.push({
          slug: m.slug,
          displayName: m.display_name || m.slug,
          defaultEffort: m.default_reasoning_level || "medium",
          supportedEfforts: (m.supported_reasoning_levels ?? [])
            .map((e) => e.effort)
            .filter((e): e is string => Boolean(e)),
          engine: "codex",
        });
      }
    } catch {
      // Ignore parse error, fall back below
    }
  }

  if (models.length === 0) {
    models.push({
      slug: defaults.model || "gpt-6.2-sol",
      displayName: defaults.model || "GPT-6.2-Sol",
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      engine: "codex",
    });
  }

  const validEfforts = new Set<ReasoningEffort>([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  const rawEffort = (defaults.effort || "medium") as ReasoningEffort;
  const defaultEffort: ReasoningEffort = validEfforts.has(rawEffort)
    ? rawEffort
    : "medium";
  const defaultModel = defaults.model || models[0].slug;

  return { models, defaultModel, defaultEffort };
}

export function resolveCodexBinary(): string | null {
  const candidates: string[] = [];

  if (
    process.env.CODEX_CLI_PATH &&
    fs.existsSync(process.env.CODEX_CLI_PATH)
  ) {
    return process.env.CODEX_CLI_PATH;
  }

  const toml = readCodexTomlDefaults();
  if (toml.codexCliPath && fs.existsSync(toml.codexCliPath)) {
    return toml.codexCliPath;
  }

  const windowsApps = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "WindowsApps",
  );
  if (fs.existsSync(windowsApps)) {
    try {
      const dirs = fs
        .readdirSync(windowsApps)
        .filter((d) => d.startsWith("OpenAI.Codex_"))
        .sort((a, b) =>
          compareVersionsDesc(parseVersionTuple(a), parseVersionTuple(b)),
        );
      for (const dir of dirs) {
        const exe = path.join(windowsApps, dir, "app", "resources", "codex.exe");
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    } catch {
      // Ignore access issues
    }
  }

  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex"]
      : ["codex"]) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) candidates.push(full);
    }
  }

  const localCodexBin = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "OpenAI",
    "Codex",
    "bin",
  );
  if (fs.existsSync(localCodexBin)) {
    try {
      const entries = fs
        .readdirSync(localCodexBin)
        .map((sub) => path.join(localCodexBin, sub, "codex.exe"))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      candidates.push(...entries);
    } catch {
      // Ignore
    }
  }

  return candidates[0] ?? null;
}

async function isGitRepository(cwd: string): Promise<boolean> {
  if (!cwd || !fs.existsSync(cwd)) return false;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { timeout: 4000, windowsHide: true },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // Fall back below
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore
  }
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... (truncated, total ${text.length} chars)`;
}

function isTransientRateLimitError(msg: string): boolean {
  return /429|rate[_ ]?limit|usage[_ ]?limit|too many requests|timed out|timeout|ECONNRESET|ETIMEDOUT|502|503|overloaded/i.test(
    msg,
  );
}

function isQuotaOrAuthFailure(msg: string): boolean {
  return /401|402|403|429|rate[_ ]?limit|usage[_ ]?limit|quota|limit reached|insufficient|balance|unauthorized|authentication_failed|invalid token|not in accessible|尚未加入/i.test(
    msg,
  );
}

function collectRecentRolloutFiles(limit = 8): string[] {
  const sessionsDir = path.join(codexHomeDir(), "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const found: Array<{ file: string; mtimeMs: number }> = [];
  const listDesc = (dir: string) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a));

  try {
    for (const year of listDesc(sessionsDir)) {
      const yDir = path.join(sessionsDir, year);
      for (const month of listDesc(yDir)) {
        const mDir = path.join(yDir, month);
        for (const day of listDesc(mDir)) {
          const dDir = path.join(mDir, day);
          const files = fs
            .readdirSync(dDir, { withFileTypes: true })
            .filter(
              (f) =>
                f.isFile() &&
                f.name.startsWith("rollout-") &&
                f.name.endsWith(".jsonl"),
            )
            .map((f) => {
              const full = path.join(dDir, f.name);
              return { file: full, mtimeMs: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
          found.push(...files);
          if (found.length >= limit) {
            return found
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, limit)
              .map((x) => x.file);
          }
        }
      }
    }
  } catch {
    // Ignore traversal errors
  }

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((x) => x.file);
}

function parseQuotaWindow(
  raw: Record<string, unknown> | null | undefined,
  nowSec: number,
): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const rawUsed = Number(raw.used_percent);
  if (!Number.isFinite(rawUsed)) return null;
  const windowMinutes = Number(raw.window_minutes) || 0;
  const resetsAt =
    typeof raw.resets_at === "number" && Number.isFinite(raw.resets_at)
      ? raw.resets_at
      : null;
  const resetPassed = resetsAt !== null && nowSec >= resetsAt;
  const usedPercent = resetPassed ? 0 : Math.min(100, Math.max(0, rawUsed));
  const remainingPercent = Math.round((100 - usedPercent) * 10) / 10;
  return {
    usedPercent: Math.round(usedPercent * 10) / 10,
    remainingPercent,
    windowMinutes,
    resetsAt,
    resetPassed,
  };
}

function formatResetShort(resetsAt: number | null, includeDate = false): string {
  if (!resetsAt) return "未知";
  const d = new Date(resetsAt * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (!includeDate) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${mo}-${day} ${hh}:${mm}`;
}

export function readCodexQuota(
  cooldownUntil: number | null = null,
): CodexQuotaInfo {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const files = collectRecentRolloutFiles(8);

  let latestRateLimits: Record<string, unknown> | null = null;
  let sampledAt: number | null = null;

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const readSize = Math.min(stat.size, 262_144);
      const fd = fs.openSync(file, "r");
      let text = "";
      try {
        const buf = Buffer.allocUnsafe(readSize);
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i].trim();
        if (!ln || !ln.includes('"token_count"')) continue;
        try {
          const obj = JSON.parse(ln) as {
            timestamp?: string;
            type?: string;
            payload?: {
              type?: string;
              rate_limits?: Record<string, unknown> | null;
            };
          };
          if (
            obj.type === "event_msg" &&
            obj.payload?.type === "token_count" &&
            obj.payload.rate_limits
          ) {
            latestRateLimits = obj.payload.rate_limits;
            const parsedTs = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
            sampledAt = Number.isFinite(parsedTs) ? parsedTs : stat.mtimeMs;
            break;
          }
        } catch {
          // Ignore partial line
        }
      }
      if (latestRateLimits) break;
    } catch {
      // Try next file
    }
  }

  const activeCooldown =
    cooldownUntil && cooldownUntil > nowMs ? cooldownUntil : null;

  if (!latestRateLimits) {
    return {
      available: false,
      planType: null,
      primary: null,
      secondary: null,
      effectiveRemainingPct: null,
      health: activeCooldown ? "exhausted" : "unknown",
      canAutoUse: !activeCooldown,
      recommendedMaxConcurrency: activeCooldown ? 0 : 2,
      recommendedMaxEffort: activeCooldown ? "low" : "medium",
      hasExtraCredits: false,
      sampledAt: null,
      cooldownUntil: activeCooldown,
      summary: activeCooldown
        ? `限流冷却中 (至 ${formatResetShort(Math.ceil(activeCooldown / 1000))})`
        : "暂无近期 Codex 会话额度采样，按默认均衡策略运行",
    };
  }

  const primary = parseQuotaWindow(
    latestRateLimits.primary as Record<string, unknown> | undefined,
    nowSec,
  );
  const secondary = parseQuotaWindow(
    latestRateLimits.secondary as Record<string, unknown> | undefined,
    nowSec,
  );
  const credits = latestRateLimits.credits as
    | { has_credits?: boolean; unlimited?: boolean; balance?: string | number }
    | undefined;
  const hasExtraCredits = Boolean(
    credits?.unlimited ||
      (credits?.has_credits && Number(credits.balance ?? 0) > 0),
  );
  const planType =
    typeof latestRateLimits.plan_type === "string"
      ? latestRateLimits.plan_type
      : null;
  const limitReachedType = latestRateLimits.rate_limit_reached_type;

  const remainingCandidates: number[] = [];
  if (primary) remainingCandidates.push(primary.remainingPercent);
  if (secondary) remainingCandidates.push(secondary.remainingPercent);
  const effectiveRemainingPct =
    remainingCandidates.length > 0 ? Math.min(...remainingCandidates) : null;

  const neitherResetPassed =
    (!primary || !primary.resetPassed) &&
    (!secondary || !secondary.resetPassed);

  let health: QuotaHealth = "unknown";
  let canAutoUse = true;
  let recommendedMaxConcurrency = 2;
  let recommendedMaxEffort: ReasoningEffort = "medium";

  if (activeCooldown) {
    health = "exhausted";
    canAutoUse = false;
    recommendedMaxConcurrency = 0;
    recommendedMaxEffort = "low";
  } else if (
    !hasExtraCredits &&
    ((limitReachedType != null && neitherResetPassed) ||
      (effectiveRemainingPct !== null && effectiveRemainingPct < 5))
  ) {
    health = "exhausted";
    canAutoUse = false;
    recommendedMaxConcurrency = 0;
    recommendedMaxEffort = "low";
  } else if (
    hasExtraCredits ||
    (effectiveRemainingPct !== null && effectiveRemainingPct >= 50)
  ) {
    health = "abundant";
    canAutoUse = true;
    recommendedMaxConcurrency = 3;
    recommendedMaxEffort = "high";
  } else if (effectiveRemainingPct !== null && effectiveRemainingPct >= 20) {
    health = "moderate";
    canAutoUse = true;
    recommendedMaxConcurrency = 2;
    recommendedMaxEffort = "medium";
  } else if (effectiveRemainingPct !== null) {
    health = "low";
    canAutoUse = true;
    recommendedMaxConcurrency = 1;
    recommendedMaxEffort = "low";
  }

  const pText = primary
    ? `5h剩余 ${primary.remainingPercent}% (重置 ${formatResetShort(primary.resetsAt)})`
    : "5h未知";
  const sText = secondary
    ? `7天剩余 ${secondary.remainingPercent}% (重置 ${formatResetShort(secondary.resetsAt, true)})`
    : "7天未知";

  return {
    available: true,
    planType,
    primary,
    secondary,
    effectiveRemainingPct,
    health,
    canAutoUse,
    recommendedMaxConcurrency,
    recommendedMaxEffort,
    hasExtraCredits,
    sampledAt,
    cooldownUntil: activeCooldown,
    summary: `${pText} | ${sText}`,
  };
}

export function mapPresetToEffort(
  preset?: "fast" | "balanced" | "deep",
  explicit?: ReasoningEffort,
  fallback: ReasoningEffort = "medium",
): ReasoningEffort {
  if (explicit) return explicit;
  if (preset === "fast") return "low";
  if (preset === "balanced") return "medium";
  if (preset === "deep") return "high";
  return fallback;
}

function classifyComplexity(input: DispatchTaskInput): "fast" | "balanced" | "deep" {
  const mode = input.mode || "read-only";
  const text = `${input.name} ${input.role ?? ""} ${input.prompt}`;
  const stepCount = input.steps?.length ?? 0;

  const isDeep =
    mode === "review" ||
    /架构|重构|并发|死锁|安全|漏洞|根因|性能|算法|疑难|迁移|审计|review|audit|security|architect|refactor|concurren|deadlock|race|debug|root cause|memory leak|optimi[sz]e/i.test(
      text,
    ) ||
    stepCount >= 5 ||
    input.prompt.length >= 1200;

  if (isDeep) return "deep";

  const isFast =
    mode === "read-only" &&
    (/总结|梳理|查找|搜索|列出|注释|文档|格式|翻译|检查|目录|结构|readme|summary|list|search|doc|comment|typo|format|explore|inspect/i.test(
      text,
    ) ||
      input.prompt.length < 350 ||
      stepCount <= 2);

  return isFast ? "fast" : "balanced";
}

export function analyzeAndRouteDualEngine(
  input: DispatchTaskInput,
  env: {
    codexAvailable: boolean;
    codexDefaultModel: string;
    codexQuota: CodexQuotaInfo;
    claude: ClaudeEnvironmentInfo;
    settings: OrchestratorSettings;
  },
): {
  engine: TaskEngine;
  model: string;
  effort: ReasoningEffort;
  complexity: "fast" | "balanced" | "deep";
  reason: string;
  autoRouted: boolean;
} {
  const complexity = classifyComplexity(input);
  const mode = input.mode || "read-only";
  const codexReady = env.codexAvailable && env.codexQuota.canAutoUse;
  const claudeReady = env.claude.canAutoUse;

  // Infer engine from explicit model prefix when engine is omitted or "auto"
  let engine: TaskEngine;
  let engineReason = "";
  const reqEngine = input.engine && input.engine !== "auto" ? input.engine : undefined;

  if (reqEngine) {
    engine = reqEngine;
    engineReason = `指定引擎 ${reqEngine}`;
  } else if (input.model?.startsWith("claude")) {
    engine = "claude";
    engineReason = `按模型推断 claude`;
  } else if (input.model?.startsWith("gpt-") || input.model?.startsWith("codex")) {
    engine = "codex";
    engineReason = `按模型推断 codex`;
  } else {
    const strat = env.settings.routingStrategy;
    if (strat === "codex-only") {
      engine = "codex";
      engineReason = "策略: 仅 GPT";
    } else if (strat === "claude-only") {
      engine = "claude";
      engineReason = "策略: 仅 Claude";
    } else if (strat === "quality-first") {
      if (complexity === "deep" && mode !== "review" && claudeReady) {
        engine = "claude";
        engineReason = "质量优先(深度编码/架构 → Claude)";
      } else if (codexReady) {
        engine = "codex";
        engineReason = "质量优先(Plus 订阅协同 → GPT)";
      } else if (claudeReady) {
        engine = "claude";
        engineReason = "跨引擎补位(GPT 不可用 → Claude)";
      } else {
        engine = "codex";
        engineReason = "默认回落 codex";
      }
    } else {
      // cost-smart (default): prefer flat-rate GPT Plus, spill over to Claude API when GPT exhausted
      if (codexReady) {
        engine = "codex";
        const pct = env.codexQuota.effectiveRemainingPct;
        engineReason = `省钱路由(GPT Plus ${pct !== null ? `剩余${pct}%` : "可用"})`;
      } else if (claudeReady) {
        engine = "claude";
        engineReason = "跨引擎补位(GPT额度耗尽 → Claude API)";
      } else {
        engine = "codex";
        engineReason = "双引擎均受限";
      }
    }
  }

  const explicitEffort =
    input.effort && input.effort !== "auto" ? input.effort : undefined;

  if (engine === "claude") {
    const cModels = env.claude.models;
    const nearDailyCap =
      env.claude.dailyBudgetUsd > 0 &&
      env.claude.dailyCostUsd >= env.claude.dailyBudgetUsd * 0.7;

    let model = input.model || cModels.balanced;
    let effort: ReasoningEffort;

    if (explicitEffort || input.preset) {
      effort = mapPresetToEffort(input.preset, explicitEffort, "medium");
      if (!input.model) {
        model =
          effort === "low"
            ? cModels.fast
            : effort === "high" || effort === "xhigh"
              ? cModels.deep
              : cModels.balanced;
      }
      return {
        engine,
        model,
        effort,
        complexity,
        reason: `${engineReason} · 指定 ${model}/${effort}`,
        autoRouted: !reqEngine,
      };
    }

    if (complexity === "fast") {
      model = input.model || cModels.fast;
      effort = "low";
    } else if (complexity === "balanced") {
      model = input.model || cModels.balanced;
      effort = "medium";
    } else {
      // deep
      if (nearDailyCap) {
        model = input.model || cModels.balanced;
        effort = "medium";
      } else {
        model = input.model || cModels.deep;
        effort = "high";
      }
    }

    const clLabel =
      complexity === "fast" ? "轻量" : complexity === "balanced" ? "中等" : "深度";
    const reason =
      nearDailyCap && complexity === "deep"
        ? `${engineReason} · 日预算接近上限降档(${clLabel}): ${model}/${effort}`
        : `${engineReason} · 自动(${clLabel}): ${model}/${effort}`;

    return {
      engine,
      model,
      effort,
      complexity,
      reason,
      autoRouted: true,
    };
  }

  // Codex routing
  const model = input.model || env.codexDefaultModel;
  if (explicitEffort || input.preset) {
    const effort = mapPresetToEffort(
      input.preset,
      explicitEffort,
      env.settings.defaultEffort,
    );
    return {
      engine: "codex",
      model,
      effort,
      complexity,
      reason: `${engineReason} · 指定 ${model}/${effort}`,
      autoRouted: !reqEngine,
    };
  }

  let chosen: ReasoningEffort;
  if (env.codexQuota.health === "low" || env.codexQuota.health === "exhausted") {
    chosen = "low";
  } else if (env.codexQuota.health === "moderate") {
    if (complexity === "fast") chosen = "low";
    else if (complexity === "balanced") chosen = "medium";
    else chosen = mode === "review" ? "high" : "medium";
  } else {
    if (complexity === "fast") chosen = "low";
    else if (complexity === "balanced") chosen = "medium";
    else chosen = "high";
  }

  const clLabel =
    complexity === "fast" ? "轻量" : complexity === "balanced" ? "中等" : "深度";
  const pctText =
    env.codexQuota.effectiveRemainingPct !== null
      ? `剩余${env.codexQuota.effectiveRemainingPct}%`
      : "未采样";
  const downgraded =
    (complexity === "deep" && chosen !== "high") ||
    (complexity === "balanced" && chosen === "low");

  const reason = downgraded
    ? `额度保护降档(${clLabel} × ${pctText}): ${chosen}`
    : `${engineReason} · 自动(${clLabel}): ${chosen}`;

  return {
    engine: "codex",
    model,
    effort: chosen,
    complexity,
    reason,
    autoRouted: true,
  };
}

export class CodexOrchestrator {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly promptDir: string;
  private tasks: CodexTask[] = [];
  private settings: OrchestratorSettings;
  private activeChildren = new Map<string, ChildProcess>();
  private timers = new Map<string, NodeJS.Timeout>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private waiters = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | null = null;

  private cachedEnv: CodexEnvironmentInfo | null = null;
  private envCheckedAt = 0;
  private rateLimitCooldownUntil: number | null = null;
  private claudeCooldownUntil: number | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "runs.json");
    this.promptDir = path.join(dataDir, "prompts");
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.promptDir, { recursive: true });

    const { defaultModel, defaultEffort } = loadAvailableModels();
    this.settings = {
      maxConcurrency: 3,
      defaultModel,
      defaultEffort: defaultEffort === "high" ? "medium" : defaultEffort,
      defaultTimeoutSec: 600,
      autoRetryOnRateLimit: true,
      autoOrchestrate: true,
      routingStrategy: "cost-smart",
      claudeDailyBudgetUsd: 0,
      claudeMaxTaskBudgetUsd: 0,
      autoFallback: true,
    };

    this.loadState();
  }

  private loadState(): void {
    if (!fs.existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.statePath, "utf8"),
      ) as PersistedState;
      if (raw.settings) {
        const rawDaily = Number(raw.settings.claudeDailyBudgetUsd);
        const rawTask = Number(raw.settings.claudeMaxTaskBudgetUsd);
        this.settings = {
          ...this.settings,
          ...raw.settings,
          maxConcurrency: Math.min(
            6,
            Math.max(1, Number(raw.settings.maxConcurrency) || 3),
          ),
          claudeDailyBudgetUsd:
            Number.isFinite(rawDaily) && rawDaily >= 0 ? rawDaily : 0,
          claudeMaxTaskBudgetUsd:
            Number.isFinite(rawTask) && rawTask >= 0 ? rawTask : 0,
        };
      }
      if (Array.isArray(raw.tasks)) {
        const now = Date.now();
        this.tasks = raw.tasks.slice(0, MAX_TASKS_STORED).map((t) => {
          const withEngine: CodexTask = {
            ...t,
            engine: t.engine === "claude" ? "claude" : "codex",
          };
          if (withEngine.status === "running" || withEngine.status === "queued") {
            return {
              ...withEngine,
              status: "failed" as TaskStatus,
              phase: "服务重启导致中断",
              error: "MCP server restarted while task was active",
              finishedAt: now,
            };
          }
          return withEngine;
        });
      }
    } catch {
      // Ignore corrupt runs.json
    }
  }

  private scheduleSave(immediate = false): void {
    if (immediate) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.flushSave();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, 300);
  }

  private flushSave(): void {
    try {
      const payload: PersistedState = {
        settings: this.settings,
        tasks: this.tasks.slice(0, MAX_TASKS_STORED),
      };
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, this.statePath);
    } catch {
      // Ignore write errors
    }
  }

  private notifyWaiters(): void {
    for (const resolve of Array.from(this.waiters)) {
      resolve();
    }
  }

  private computeTodayClaudeSpendUsd(): number {
    let sum = 0;
    for (const t of this.tasks) {
      if (
        t.engine === "claude" &&
        typeof t.costUsd === "number" &&
        isTodayLocal(t.finishedAt || t.createdAt)
      ) {
        sum += t.costUsd;
      }
    }
    return Math.round(sum * 10000) / 10000;
  }

  private buildClaudeEnvSync(
    claudePath: string | null,
    claudeVersion: string | null,
  ): ClaudeEnvironmentInfo {
    const cfg = loadClaudeConfig();
    const nowMs = Date.now();
    const cooldownUntil =
      this.claudeCooldownUntil && this.claudeCooldownUntil > nowMs
        ? this.claudeCooldownUntil
        : null;
    const dailyCostUsd = this.computeTodayClaudeSpendUsd();
    const hasDailyCap = this.settings.claudeDailyBudgetUsd > 0;
    const underBudget =
      !hasDailyCap || dailyCostUsd < this.settings.claudeDailyBudgetUsd;
    const canAutoUse = Boolean(
      claudePath && cfg.configured && !cooldownUntil && underBudget,
    );

    let summary = "";
    if (!claudePath) {
      summary = "未检测到 claude.exe";
    } else if (!cfg.configured) {
      summary = "未配置 Claude 登录或 API Key";
    } else if (cooldownUntil) {
      summary = `API 限流/鉴权冷却中 (至 ${formatResetShort(Math.ceil(cooldownUntil / 1000))})`;
    } else if (!underBudget) {
      summary = `今日已达预算上限 ($${dailyCostUsd.toFixed(2)} / $${this.settings.claudeDailyBudgetUsd.toFixed(2)})`;
    } else if (!hasDailyCap) {
      summary = `就绪 (${cfg.baseUrl || "API"} · 今日 $${dailyCostUsd.toFixed(2)} · 无上限)`;
    } else {
      summary = `就绪 (${cfg.baseUrl || "API"} · 今日 $${dailyCostUsd.toFixed(2)} / $${this.settings.claudeDailyBudgetUsd.toFixed(2)})`;
    }

    return {
      claudePath,
      claudeVersion,
      configured: cfg.configured,
      baseUrl: cfg.baseUrl,
      models: {
        fast: cfg.fastModel,
        balanced: cfg.balancedModel,
        deep: cfg.deepModel,
      },
      availableModels: cfg.availableModels,
      dailyCostUsd,
      dailyBudgetUsd: this.settings.claudeDailyBudgetUsd,
      maxTaskBudgetUsd: this.settings.claudeMaxTaskBudgetUsd,
      cooldownUntil,
      canAutoUse,
      summary,
    };
  }

  async getEnvironment(forceRefresh = false): Promise<CodexEnvironmentInfo> {
    const now = Date.now();
    const quota = readCodexQuota(this.rateLimitCooldownUntil);

    if (!forceRefresh && this.cachedEnv && now - this.envCheckedAt < 30_000) {
      const claude = this.buildClaudeEnvSync(
        this.cachedEnv.claude.claudePath,
        this.cachedEnv.claude.claudeVersion,
      );
      this.cachedEnv = { ...this.cachedEnv, quota, claude };
      return this.cachedEnv;
    }

    const { models, defaultModel, defaultEffort } = loadAvailableModels();
    const codexPath = resolveCodexBinary();
    let codexVersion: string | null = null;
    let loggedIn = false;
    let loginMessage = codexPath ? "未检测" : "未找到 codex.exe";

    if (codexPath) {
      try {
        const { stdout, stderr } = await execFileAsync(
          codexPath,
          ["--version"],
          { timeout: 6000, windowsHide: true },
        );
        codexVersion = (stdout || stderr).trim();
      } catch (err) {
        codexVersion = null;
        loginMessage = `版本检查失败: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          codexPath,
          ["login", "status"],
          { timeout: 6000, windowsHide: true },
        );
        const combined = `${stdout}\n${stderr}`.trim();
        loggedIn = /logged in/i.test(combined);
        loginMessage = combined || (loggedIn ? "Logged in" : "Not logged in");
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
        loggedIn = /logged in/i.test(combined);
        loginMessage = combined || e.message || "login status failed";
      }
    }

    const claudePath = resolveClaudeBinary();
    let claudeVersion: string | null = null;
    if (claudePath) {
      try {
        const { stdout, stderr } = await execFileAsync(
          claudePath,
          ["--version"],
          { timeout: 6000, windowsHide: true },
        );
        claudeVersion = (stdout || stderr).trim();
      } catch {
        claudeVersion = null;
      }
    }

    const claude = this.buildClaudeEnvSync(claudePath, claudeVersion);

    this.cachedEnv = {
      codexPath,
      codexVersion,
      loggedIn,
      loginMessage,
      models,
      defaultModel,
      defaultEffort,
      quota,
      claude,
    };
    this.envCheckedAt = now;
    return this.cachedEnv;
  }

  getSettings(): OrchestratorSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<OrchestratorSettings>): OrchestratorSettings {
    if (patch.maxConcurrency !== undefined) {
      this.settings.maxConcurrency = Math.min(
        6,
        Math.max(1, Math.round(patch.maxConcurrency)),
      );
    }
    if (patch.defaultModel) {
      this.settings.defaultModel = patch.defaultModel;
    }
    if (patch.defaultEffort) {
      this.settings.defaultEffort = patch.defaultEffort;
    }
    if (patch.defaultTimeoutSec !== undefined) {
      this.settings.defaultTimeoutSec = Math.min(
        1800,
        Math.max(30, Math.round(patch.defaultTimeoutSec)),
      );
    }
    if (patch.autoRetryOnRateLimit !== undefined) {
      this.settings.autoRetryOnRateLimit = Boolean(patch.autoRetryOnRateLimit);
    }
    if (patch.autoOrchestrate !== undefined) {
      this.settings.autoOrchestrate = Boolean(patch.autoOrchestrate);
    }
    if (patch.routingStrategy !== undefined) {
      this.settings.routingStrategy = patch.routingStrategy;
    }
    if (patch.claudeDailyBudgetUsd !== undefined) {
      const val = Number(patch.claudeDailyBudgetUsd);
      this.settings.claudeDailyBudgetUsd = Number.isFinite(val)
        ? Math.min(1000, Math.max(0, val))
        : 0;
    }
    if (patch.claudeMaxTaskBudgetUsd !== undefined) {
      const val = Number(patch.claudeMaxTaskBudgetUsd);
      this.settings.claudeMaxTaskBudgetUsd = Number.isFinite(val)
        ? Math.min(200, Math.max(0, val))
        : 0;
    }
    if (patch.autoFallback !== undefined) {
      this.settings.autoFallback = Boolean(patch.autoFallback);
    }
    this.scheduleSave(true);
    this.pumpQueue();
    return this.getSettings();
  }

  async dispatchBatch(
    inputs: DispatchTaskInput[],
    options?: {
      batchTitle?: string;
      defaultCwd?: string;
      respectQuota?: boolean;
    },
  ): Promise<{
    batchId: string;
    tasks: CodexTask[];
    skippedDueToQuota?: boolean;
    quota: CodexQuotaInfo;
    claude: ClaudeEnvironmentInfo;
  }> {
    const env = await this.getEnvironment(false);
    const respectQuota = options?.respectQuota ?? true;
    const codexReady = Boolean(env.codexPath && env.loggedIn && env.quota.canAutoUse);
    const claudeReady = env.claude.canAutoUse;

    if (respectQuota) {
      const strat = this.settings.routingStrategy;
      const anyRequestedExplicit = inputs.some((x) => x.engine && x.engine !== "auto");
      if (!anyRequestedExplicit) {
        const blocked =
          (strat === "codex-only" && !codexReady) ||
          (strat === "claude-only" && !claudeReady) ||
          (!codexReady && !claudeReady);
        if (blocked) {
          return {
            batchId: "",
            tasks: [],
            skippedDueToQuota: true,
            quota: env.quota,
            claude: env.claude,
          };
        }
      }
    }

    const batchId = `batch_${crypto.randomBytes(4).toString("hex")}`;
    const created: CodexTask[] = [];
    const now = Date.now();

    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i];
      const steps: TaskStep[] = (item.steps ?? [])
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label) => ({ label, status: "pending" as StepStatus }));

      const route = analyzeAndRouteDualEngine(item, {
        codexAvailable: Boolean(env.codexPath && env.loggedIn),
        codexDefaultModel: this.settings.defaultModel,
        codexQuota: env.quota,
        claude: env.claude,
        settings: this.settings,
      });

      const task: CodexTask = {
        id: `${route.engine === "claude" ? "cld" : "gpt"}_${crypto.randomBytes(4).toString("hex")}`,
        batchId,
        batchTitle: options?.batchTitle,
        engine: route.engine,
        name:
          item.name.trim() ||
          `${route.engine === "claude" ? "Claude" : "GPT"} Worker ${i + 1}`,
        role:
          item.role?.trim() ||
          (item.mode === "review" ? "Code Reviewer" : "Subagent"),
        prompt: item.prompt,
        cwd: item.cwd || options?.defaultCwd || process.cwd(),
        mode: item.mode || "read-only",
        worktree: Boolean(item.worktree),
        model: route.model,
        effort: route.effort,
        autoRouted: route.autoRouted,
        routeReason: route.reason,
        steps,
        status: "queued",
        progress: 2,
        phase: "排队等待并发槽位",
        createdAt: now + i,
        retryCount: 0,
        timeoutSec: Math.min(
          1800,
          Math.max(30, item.timeoutSec ?? this.settings.defaultTimeoutSec),
        ),
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        changedFiles: [],
        logs: [
          {
            ts: now,
            kind: "info",
            text: `已入队 [${route.engine.toUpperCase()}] · ${route.reason}`,
          },
        ],
      };
      created.push(task);
    }

    this.tasks = [...created, ...this.tasks].slice(0, MAX_TASKS_STORED);
    this.scheduleSave(true);
    this.pumpQueue();
    return { batchId, tasks: created, quota: env.quota, claude: env.claude };
  }

  async resumeTask(
    taskId: string,
    prompt: string,
    options?: { steps?: string[]; timeoutSec?: number },
  ): Promise<CodexTask> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.threadId) {
      throw new Error(
        `Task ${taskId} (${task.name}) has no saved session/threadId to resume.`,
      );
    }
    if (task.status === "running" || task.status === "queued") {
      throw new Error(`Task ${taskId} is currently ${task.status}.`);
    }

    task.prompt = prompt;
    if (options?.steps) {
      task.steps = options.steps
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label) => ({ label, status: "pending" as StepStatus }));
    }
    if (options?.timeoutSec) {
      task.timeoutSec = Math.min(1800, Math.max(30, options.timeoutSec));
    }
    task.status = "queued";
    task.progress = 5;
    task.phase = "恢复会话排队中";
    task.error = undefined;
    task.finishedAt = undefined;
    this.appendLog(
      task,
      "info",
      `追问 (${task.threadId.slice(0, 8)}): ${truncateText(prompt.replace(/\s+/g, " "), 180)}`,
    );
    this.scheduleSave(true);
    this.pumpQueue();
    return task;
  }

  retryTask(taskId: string): CodexTask {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === "running" || task.status === "queued") {
      return task;
    }
    task.status = "queued";
    task.progress = 3;
    task.phase = "手动重试排队中";
    task.error = undefined;
    task.finishedAt = undefined;
    task.retryCount = 0;
    for (const s of task.steps) s.status = "pending";
    this.appendLog(task, "info", "用户触发重试");
    this.scheduleSave(true);
    this.pumpQueue();
    return task;
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const retryTimer = this.retryTimers.get(taskId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(taskId);
    }

    if (task.status === "queued") {
      task.status = "cancelled";
      task.phase = "已取消";
      task.finishedAt = Date.now();
      this.appendLog(task, "info", "任务在排队阶段被取消");
      this.scheduleSave(true);
      this.notifyWaiters();
      return true;
    }

    if (task.status === "running") {
      task.status = "cancelled";
      task.phase = "正在停止...";
      task.finishedAt = Date.now();
      this.appendLog(task, "info", "任务已取消");
      const child = this.activeChildren.get(taskId);
      if (child) killProcessTree(child);
      this.cleanupTaskTimer(taskId);
      this.scheduleSave(true);
      this.notifyWaiters();
      this.pumpQueue();
      return true;
    }

    return false;
  }

  cancelAllActive(): number {
    let count = 0;
    for (const t of this.tasks) {
      if (t.status === "queued" || t.status === "running") {
        if (this.cancelTask(t.id)) count++;
      }
    }
    return count;
  }

  clearFinished(): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(
      (t) => t.status === "running" || t.status === "queued",
    );
    this.scheduleSave(true);
    return before - this.tasks.length;
  }

  getTasks(filter?: { taskIds?: string[]; batchId?: string }): CodexTask[] {
    let list = this.tasks;
    if (filter?.batchId) {
      list = list.filter((t) => t.batchId === filter.batchId);
    }
    if (filter?.taskIds && filter.taskIds.length > 0) {
      const set = new Set(filter.taskIds);
      list = list.filter((t) => set.has(t.id));
    }
    return list;
  }

  async waitForTasks(
    filter: { taskIds?: string[]; batchId?: string },
    waitSec = 0,
  ): Promise<CodexTask[]> {
    const clampedSec = Math.min(45, Math.max(0, waitSec));
    if (clampedSec <= 0) {
      return this.getTasks(filter);
    }

    const deadline = Date.now() + clampedSec * 1000;
    while (true) {
      const watched = this.getTasks(filter);
      const anyActive = watched.some(
        (t) => t.status === "queued" || t.status === "running",
      );
      if (!anyActive || watched.length === 0) {
        return watched;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return watched;
      }
      await new Promise<void>((resolve) => {
        const onWake = () => {
          clearTimeout(timer);
          this.waiters.delete(onWake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(onWake);
          resolve();
        }, Math.min(remaining, 1500));
        this.waiters.add(onWake);
      });
    }
  }

  async getSnapshot(options?: {
    includeLogs?: boolean;
    taskLimit?: number;
  }): Promise<DashboardSnapshot> {
    const env = await this.getEnvironment(false);
    const includeLogs = options?.includeLogs ?? true;
    const limit = options?.taskLimit ?? 30;

    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let progressSum = 0;
    let totalInputTokens = 0;
    let totalCachedTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const t of this.tasks) {
      if (t.status === "queued") queued++;
      else if (t.status === "running") running++;
      else if (t.status === "completed") completed++;
      else if (t.status === "failed") failed++;
      else if (t.status === "cancelled") cancelled++;
      progressSum += t.progress;
      totalInputTokens += t.usage.inputTokens;
      totalCachedTokens += t.usage.cachedInputTokens;
      totalOutputTokens += t.usage.outputTokens;
      if (typeof t.costUsd === "number") totalCostUsd += t.costUsd;
    }

    const total = this.tasks.length;
    const overallProgress = total > 0 ? Math.round(progressSum / total) : 0;

    const tasks = this.tasks.slice(0, limit).map((t) => ({
      ...t,
      prompt: truncateText(t.prompt, 2000),
      finalMessage: t.finalMessage
        ? truncateText(t.finalMessage, MAX_FINAL_MSG_IN_SNAPSHOT)
        : undefined,
      logs: includeLogs ? t.logs.slice(-30) : [],
    }));

    return {
      environment: {
        codexPath: env.codexPath,
        codexVersion: env.codexVersion,
        loggedIn: env.loggedIn,
        loginMessage: env.loginMessage,
        models: env.models,
        quota: env.quota,
        claude: env.claude,
      },
      settings: this.getSettings(),
      summary: {
        total,
        queued,
        running,
        completed,
        failed,
        cancelled,
        overallProgress,
        totalInputTokens,
        totalCachedTokens,
        totalOutputTokens,
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      },
      tasks,
      serverTime: Date.now(),
    };
  }

  private pumpQueue(): void {
    const runningCount = this.tasks.filter(
      (t) => t.status === "running",
    ).length;
    const quota = readCodexQuota(this.rateLimitCooldownUntil);
    const effectiveCap =
      this.settings.autoOrchestrate && quota.recommendedMaxConcurrency > 0
        ? Math.min(
            this.settings.maxConcurrency,
            quota.recommendedMaxConcurrency,
          )
        : this.settings.maxConcurrency;
    const availableSlots = Math.max(0, effectiveCap - runningCount);
    if (availableSlots === 0) return;

    const queuedTasks = this.tasks
      .filter((t) => t.status === "queued")
      .slice()
      .reverse();

    for (let i = 0; i < Math.min(availableSlots, queuedTasks.length); i++) {
      const next = queuedTasks[i];
      if (next.engine === "claude") {
        void this.startClaudeTask(next);
      } else {
        void this.startCodexTask(next);
      }
    }
  }

  private async startCodexTask(task: CodexTask): Promise<void> {
    if (task.status !== "queued") return;

    const env = await this.getEnvironment(false);
    if (!env.codexPath) {
      task.status = "failed";
      task.phase = "未找到 codex.exe";
      task.error =
        "未能定位 codex.exe。请确认已安装 Codex Desktop 或 `@openai/codex` CLI。";
      task.finishedAt = Date.now();
      this.appendLog(task, "error", task.error);
      this.scheduleSave(true);
      this.notifyWaiters();
      return;
    }

    if (!fs.existsSync(task.cwd)) {
      task.status = "failed";
      task.phase = "工作目录不存在";
      task.error = `Working directory does not exist: ${task.cwd}`;
      task.finishedAt = Date.now();
      this.appendLog(task, "error", task.error);
      this.scheduleSave(true);
      this.notifyWaiters();
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();
    task.progress = Math.max(task.progress, 5);
    task.phase = "启动 Codex 会话...";
    this.scheduleSave();

    const isGit = await isGitRepository(task.cwd);
    const useResume = Boolean(task.threadId);
    const lastMsgFile = path.join(this.promptDir, `${task.id}.last.txt`);

    let finalPrompt = this.buildEffectivePrompt(task);
    if (finalPrompt.length > 20_000) {
      const promptFile = path.join(this.promptDir, `${task.id}.prompt.md`);
      fs.writeFileSync(promptFile, finalPrompt, "utf8");
      finalPrompt = `Please read and execute the complete instructions in "${promptFile}".`;
    } else if (finalPrompt.startsWith("-")) {
      finalPrompt = `\n${finalPrompt}`;
    }

    const args: string[] = ["exec"];
    if (useResume && task.threadId) {
      args.push("resume", task.threadId, "--json");
      if (task.model) args.push("-m", task.model);
      args.push("-c", `model_reasoning_effort="${task.effort}"`);
      if (!isGit) args.push("--skip-git-repo-check");
      args.push("-o", lastMsgFile, finalPrompt);
    } else {
      args.push("--json", "-C", task.cwd);
      const sandboxMode =
        task.mode === "workspace-write" ? "workspace-write" : "read-only";
      args.push("-s", sandboxMode);
      if (task.model) args.push("-m", task.model);
      args.push("-c", `model_reasoning_effort="${task.effort}"`);
      if (task.worktree) {
        if (isGit && task.mode === "workspace-write") {
          args.push("--worktree");
        } else {
          this.appendLog(
            task,
            "info",
            isGit
              ? "read-only 模式无需 --worktree，已跳过"
              : "当前目录非 Git 仓库，已自动跳过 --worktree",
          );
        }
      }
      if (!isGit) args.push("--skip-git-repo-check");
      args.push("-o", lastMsgFile, finalPrompt);
    }

    this.appendLog(
      task,
      "info",
      `启动 GPT 进程 (${useResume ? "resume" : task.mode}, model=${task.model}, effort=${task.effort})`,
    );

    const child = spawn(env.codexPath, args, {
      cwd: task.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.activeChildren.set(task.id, child);
    this.armTimeout(task, child);

    let stdoutBuf = "";
    let stderrText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.processCodexJsonLine(task, line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    });

    child.on("error", (err) => {
      this.handleSpawnError(task, err);
    });

    child.on("close", (code) => {
      this.activeChildren.delete(task.id);
      this.cleanupTaskTimer(task.id);

      if (stdoutBuf.trim()) {
        this.processCodexJsonLine(task, stdoutBuf);
      }

      if (!task.finalMessage && fs.existsSync(lastMsgFile)) {
        try {
          const fallback = fs.readFileSync(lastMsgFile, "utf8").trim();
          if (fallback) task.finalMessage = fallback;
        } catch {
          // Ignore
        }
      }
      try {
        if (fs.existsSync(lastMsgFile)) fs.unlinkSync(lastMsgFile);
      } catch {
        // Ignore
      }

      this.finalizeChildExit(task, code, stderrText, env);
    });
  }

  private async startClaudeTask(task: CodexTask): Promise<void> {
    if (task.status !== "queued") return;

    const env = await this.getEnvironment(false);
    if (!env.claude.claudePath) {
      task.status = "failed";
      task.phase = "未找到 claude.exe";
      task.error = "未能定位 Claude Code CLI (claude.exe)。";
      task.finishedAt = Date.now();
      this.appendLog(task, "error", task.error);
      this.scheduleSave(true);
      this.notifyWaiters();
      return;
    }

    if (!fs.existsSync(task.cwd)) {
      task.status = "failed";
      task.phase = "工作目录不存在";
      task.error = `Working directory does not exist: ${task.cwd}`;
      task.finishedAt = Date.now();
      this.appendLog(task, "error", task.error);
      this.scheduleSave(true);
      this.notifyWaiters();
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();
    task.progress = Math.max(task.progress, 5);
    task.phase = "启动 Claude Code 会话...";
    this.scheduleSave();

    const isGit = await isGitRepository(task.cwd);
    const useResume = Boolean(task.threadId);

    let finalPrompt = this.buildEffectivePrompt(task);
    if (finalPrompt.length > 20_000) {
      const promptFile = path.join(this.promptDir, `${task.id}.prompt.md`);
      fs.writeFileSync(promptFile, finalPrompt, "utf8");
      finalPrompt = `Please read and execute the complete instructions in "${promptFile}".`;
    }

    const permMode = task.mode === "workspace-write" ? "acceptEdits" : "plan";
    const claudeEffort = task.effort === "xhigh" ? "high" : task.effort;
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      task.model || env.claude.models.balanced,
      "--effort",
      claudeEffort,
      "--permission-mode",
      permMode,
    ];

    if (this.settings.claudeMaxTaskBudgetUsd > 0) {
      args.push(
        "--max-budget-usd",
        String(this.settings.claudeMaxTaskBudgetUsd),
      );
    }

    if (
      env.claude.models.balanced &&
      task.model &&
      task.model !== env.claude.models.balanced
    ) {
      args.push("--fallback-model", env.claude.models.balanced);
    }

    if (task.worktree) {
      if (isGit && task.mode === "workspace-write") {
        args.push("--worktree");
      } else {
        this.appendLog(
          task,
          "info",
          isGit
            ? "read-only/plan 模式无需 --worktree，已跳过"
            : "当前目录非 Git 仓库，已自动跳过 --worktree",
        );
      }
    }

    if (useResume && task.threadId) {
      args.push("--resume", task.threadId);
    }

    args.push("--", finalPrompt);

    const budgetLabel =
      this.settings.claudeMaxTaskBudgetUsd > 0
        ? `预算上限 $${this.settings.claudeMaxTaskBudgetUsd}`
        : "无预算上限";
    this.appendLog(
      task,
      "info",
      `启动 Claude 进程 (${useResume ? "resume" : permMode}, model=${task.model}, effort=${claudeEffort}, ${budgetLabel})`,
    );

    const child = spawn(env.claude.claudePath, args, {
      cwd: task.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.activeChildren.set(task.id, child);
    this.armTimeout(task, child);

    let stdoutBuf = "";
    let stderrText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.processClaudeJsonLine(task, line, child);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    });

    child.on("error", (err) => {
      this.handleSpawnError(task, err);
    });

    child.on("close", (code) => {
      this.activeChildren.delete(task.id);
      this.cleanupTaskTimer(task.id);

      if (stdoutBuf.trim()) {
        this.processClaudeJsonLine(task, stdoutBuf, child);
      }

      this.finalizeChildExit(task, code, stderrText, env);
    });
  }

  private armTimeout(task: CodexTask, child: ChildProcess): void {
    const timeoutTimer = setTimeout(() => {
      if (task.status === "running") {
        task.status = "failed";
        task.phase = `超时 (${task.timeoutSec}s)`;
        task.error = `Task exceeded timeout of ${task.timeoutSec}s`;
        task.finishedAt = Date.now();
        this.appendLog(task, "error", task.error);
        killProcessTree(child);
        this.scheduleSave(true);
        this.notifyWaiters();
      }
    }, task.timeoutSec * 1000);
    this.timers.set(task.id, timeoutTimer);
  }

  private handleSpawnError(task: CodexTask, err: Error): void {
    this.activeChildren.delete(task.id);
    this.cleanupTaskTimer(task.id);
    if (task.status === "running") {
      task.status = "failed";
      task.phase = "启动失败";
      task.error = err.message;
      task.finishedAt = Date.now();
      this.appendLog(task, "error", `Spawn error: ${err.message}`);
      this.scheduleSave(true);
      this.notifyWaiters();
      this.pumpQueue();
    }
  }

  private finalizeChildExit(
    task: CodexTask,
    code: number | null,
    stderrText: string,
    env: CodexEnvironmentInfo,
  ): void {
    if (task.status === "cancelled") {
      this.notifyWaiters();
      this.pumpQueue();
      return;
    }

    if (task.status === "running") {
      if (code === 0 && !task.error) {
        task.status = "completed";
        task.progress = 100;
        task.phase = "已完成";
        for (const s of task.steps) s.status = "done";
        task.finishedAt = Date.now();
        this.appendLog(task, "info", "任务执行完成");
      } else {
        task.error =
          task.error ||
          stderrText.trim() ||
          `process exited with code ${code ?? "unknown"}`;
        task.status = "failed";
      }
    }

    if (task.status === "failed") {
      const errMsg = task.error || stderrText.trim() || "Unknown error";

      if (isQuotaOrAuthFailure(errMsg)) {
        if (task.engine === "codex") {
          this.rateLimitCooldownUntil = Date.now() + 10 * 60_000;
        } else {
          this.claudeCooldownUntil = Date.now() + 10 * 60_000;
        }
      }

      // Cross-engine automatic failover if enabled and first failure
      if (
        this.settings.autoFallback &&
        task.retryCount === 0 &&
        this.settings.routingStrategy !== "codex-only" &&
        this.settings.routingStrategy !== "claude-only"
      ) {
        const otherEngine: TaskEngine =
          task.engine === "codex" ? "claude" : "codex";
        const freshQuota = readCodexQuota(this.rateLimitCooldownUntil);
        const freshClaude = this.buildClaudeEnvSync(
          env.claude.claudePath,
          env.claude.claudeVersion,
        );
        const otherReady =
          otherEngine === "claude"
            ? freshClaude.canAutoUse
            : Boolean(env.codexPath && env.loggedIn && freshQuota.canAutoUse);

        if (otherReady && isQuotaOrAuthFailure(errMsg)) {
          const fromEngine = task.engine;
          task.engine = otherEngine;
          task.threadId = undefined;
          task.retryCount = 1;
          task.status = "queued";
          task.progress = 4;
          task.error = undefined;
          task.finishedAt = undefined;
          task.model =
            otherEngine === "claude"
              ? freshClaude.models.balanced
              : this.settings.defaultModel;
          task.effort = otherEngine === "claude" ? "medium" : task.effort;
          task.phase = `自动故障切换 → ${otherEngine === "claude" ? "Claude" : "GPT"}`;
          task.routeReason = `故障切换(${fromEngine} → ${otherEngine})`;
          this.appendLog(
            task,
            "info",
            `自动故障切换: ${fromEngine} 失败 (${truncateText(errMsg, 120)})，改派 ${otherEngine}/${task.model}`,
          );
          this.scheduleSave(true);
          this.pumpQueue();
          return;
        }
      }

      if (
        this.settings.autoRetryOnRateLimit &&
        task.retryCount < 2 &&
        isTransientRateLimitError(errMsg)
      ) {
        this.scheduleAutoRetry(task, errMsg);
        this.scheduleSave(true);
        this.notifyWaiters();
        this.pumpQueue();
        return;
      }

      task.phase = "执行失败";
      task.error = truncateText(errMsg, 2000);
      task.finishedAt = task.finishedAt ?? Date.now();
      this.appendLog(task, "error", task.error);
    }

    this.scheduleSave(true);
    this.notifyWaiters();
    this.pumpQueue();
  }

  private scheduleAutoRetry(task: CodexTask, reason: string): void {
    task.retryCount += 1;
    const delayMs = task.retryCount === 1 ? 8000 : 20000;
    task.status = "queued";
    task.phase = `限流/网络波动，${Math.round(delayMs / 1000)}s 后第 ${task.retryCount} 次重试`;
    task.error = undefined;
    task.finishedAt = undefined;
    this.appendLog(
      task,
      "info",
      `触发自动重试 (${task.retryCount}/2): ${truncateText(reason, 200)}`,
    );
    const t = setTimeout(() => {
      this.retryTimers.delete(task.id);
      if (task.status === "queued") {
        this.pumpQueue();
      }
    }, delayMs);
    this.retryTimers.set(task.id, t);
  }

  private buildEffectivePrompt(task: CodexTask): string {
    const parts: string[] = [];
    if (task.mode === "review") {
      parts.push(
        "[Code Review Mode] Focus on bugs, edge cases, security risks, and missing tests. Cite file paths and line numbers clearly.",
      );
    }
    parts.push(task.prompt);
    if (task.steps.length > 0) {
      const list = task.steps
        .map((s, idx) => `${idx + 1}. ${s.label}`)
        .join("\n");
      parts.push(
        `\n[Progress Milestones]\nAs you complete each milestone below, briefly output a line "[STEP k/${task.steps.length}]" (where k is 1..${task.steps.length}):\n${list}`,
      );
    }
    return parts.join("\n\n");
  }

  private processClaudeJsonLine(
    task: CodexTask,
    rawLine: string,
    child: ChildProcess,
  ): void {
    const line = rawLine.trim();
    if (!line.startsWith("{")) return;

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(ev.type || "");
    const subtype = String(ev.subtype || "");

    if (typeof ev.session_id === "string" && ev.session_id) {
      task.threadId = ev.session_id;
    }

    if (type === "system" && subtype === "init") {
      task.progress = Math.max(task.progress, 10);
      task.phase = "Claude 会话已建立";
      if (task.steps.length > 0 && task.steps.every((s) => s.status === "pending")) {
        task.steps[0].status = "active";
      }
      this.scheduleSave();
      return;
    }

    if (type === "system" && subtype === "api_retry") {
      const status = Number(ev.error_status) || 0;
      const attempt = Number(ev.attempt) || 1;
      const errName = String(ev.error || "api_retry");
      this.appendLog(
        task,
        "error",
        `Claude API 重试 #${attempt} (HTTP ${status || "?"}: ${errName})`,
      );
      if ([401, 402, 403].includes(status) && attempt >= 2) {
        task.error = `Claude API error HTTP ${status} (${errName})`;
        task.status = "failed";
        killProcessTree(child);
      }
      this.scheduleSave();
      return;
    }

    if (type === "assistant") {
      const msg = ev.message as Record<string, unknown> | undefined;
      if (!msg) return;
      const isSynthetic = msg.model === "<synthetic>";
      const content = Array.isArray(msg.content) ? msg.content : [];

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const bType = String(b.type || "");

        if (bType === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : "";
          task.phase = thinking
            ? `Claude 思考: ${truncateText(thinking.replace(/\s+/g, " "), 50)}`
            : "Claude 深度推理中...";
          if (thinking) {
            this.appendLog(task, "reasoning", truncateText(thinking, 300));
          }
          this.bumpProgress(task, thinking);
        } else if (bType === "tool_use") {
          const toolName = String(b.name || "Tool");
          const input = (b.input as Record<string, unknown> | undefined) ?? {};
          const filePath =
            typeof input.file_path === "string"
              ? input.file_path
              : typeof input.path === "string"
                ? input.path
                : "";
          const cmd = typeof input.command === "string" ? input.command : "";

          if (/bash|powershell/i.test(toolName)) {
            task.phase = cmd
              ? `命令: ${truncateText(cmd.replace(/\s+/g, " "), 50)}`
              : `执行 ${toolName}...`;
            this.appendLog(task, "command", `$ ${truncateText(cmd || toolName, 200)}`);
          } else if (/edit|write|notebook/i.test(toolName)) {
            if (filePath && !task.changedFiles.includes(filePath)) {
              task.changedFiles.push(filePath);
            }
            const base = filePath ? path.basename(filePath) : toolName;
            task.phase = `修改文件: ${base}`;
            this.appendLog(task, "file", `${toolName}: ${filePath || base}`);
          } else {
            task.phase = `调用工具: ${toolName}`;
            this.appendLog(
              task,
              "info",
              `工具 ${toolName}${filePath ? `: ${path.basename(filePath)}` : ""}`,
            );
          }
          this.bumpProgress(task, "");
        } else if (bType === "text") {
          const text = typeof b.text === "string" ? b.text : "";
          if (!text) continue;
          if (isSynthetic && /API Error|Failed to authenticate/i.test(text)) {
            task.error = text;
            this.appendLog(task, "error", truncateText(text, 400));
          } else {
            task.finalMessage = text;
            task.phase = "Claude 整理输出中...";
            this.appendLog(
              task,
              "message",
              truncateText(text.replace(/\s+/g, " "), 240),
            );
            this.bumpProgress(task, text);
          }
        }
      }
      this.scheduleSave();
      return;
    }

    // Final result object (type === "result" or carries total_cost_usd / modelUsage)
    if (
      type === "result" ||
      ev.total_cost_usd !== undefined ||
      ev.modelUsage !== undefined
    ) {
      if (typeof ev.total_cost_usd === "number") {
        task.costUsd = Math.round(ev.total_cost_usd * 1000000) / 1000000;
      }

      const modelUsage = ev.modelUsage as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (modelUsage && typeof modelUsage === "object") {
        let inp = 0;
        let cached = 0;
        let out = 0;
        let reason = 0;
        for (const mu of Object.values(modelUsage)) {
          if (!mu || typeof mu !== "object") continue;
          inp +=
            (Number(mu.inputTokens) || 0) +
            (Number(mu.cacheCreationInputTokens) || 0);
          cached += Number(mu.cacheReadInputTokens) || 0;
          out += Number(mu.outputTokens) || 0;
          reason += Number(mu.thinkingTokens) || 0;
        }
        if (inp + cached + out > 0) {
          task.usage = {
            inputTokens: inp + cached,
            cachedInputTokens: cached,
            outputTokens: out,
            reasoningTokens: reason,
          };
        }
      } else if (ev.usage && typeof ev.usage === "object") {
        const u = ev.usage as Record<string, unknown>;
        const cached = Number(u.cache_read_input_tokens) || 0;
        const inp =
          (Number(u.input_tokens) || 0) +
          (Number(u.cache_creation_input_tokens) || 0) +
          cached;
        const out = Number(u.output_tokens) || 0;
        if (inp + out > 0) {
          task.usage = {
            inputTokens: inp,
            cachedInputTokens: cached,
            outputTokens: out,
            reasoningTokens: 0,
          };
        }
      }

      const terminalReason = String(ev.terminal_reason || "");
      const isErr =
        ev.is_error === true ||
        terminalReason === "api_error" ||
        subtype.startsWith("error");

      if (isErr) {
        if (!task.error) {
          task.error =
            typeof ev.result === "string" && ev.result
              ? ev.result
              : `Claude ended with ${subtype || terminalReason || "error"}`;
        }
        task.status = "failed";
        task.phase = "执行失败";
      } else {
        if (typeof ev.result === "string" && ev.result && !task.finalMessage) {
          task.finalMessage = ev.result;
        }
        task.progress = 100;
        task.status = "completed";
        task.phase = "已完成";
        for (const s of task.steps) s.status = "done";
        task.finishedAt = Date.now();
      }
      this.scheduleSave(true);
    }
  }

  private processCodexJsonLine(task: CodexTask, rawLine: string): void {
    const line = rawLine.trim();
    if (!line.startsWith("{")) return;

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(ev.type || "");

    if (type === "thread.started") {
      if (typeof ev.thread_id === "string" && ev.thread_id) {
        task.threadId = ev.thread_id;
      }
      task.progress = Math.max(task.progress, 8);
      task.phase = "会话已建立";
      this.scheduleSave();
      return;
    }

    if (type === "turn.started") {
      task.progress = Math.max(task.progress, 14);
      task.phase = "模型推理中...";
      if (
        task.steps.length > 0 &&
        task.steps.every((s) => s.status === "pending")
      ) {
        task.steps[0].status = "active";
      }
      this.scheduleSave();
      return;
    }

    if (type === "turn.completed") {
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        task.usage.inputTokens += Number(usage.input_tokens) || 0;
        task.usage.cachedInputTokens += Number(usage.cached_input_tokens) || 0;
        task.usage.outputTokens += Number(usage.output_tokens) || 0;
        task.usage.reasoningTokens +=
          Number(usage.reasoning_output_tokens) || 0;
      }
      task.progress = 100;
      task.status = "completed";
      task.phase = "已完成";
      for (const s of task.steps) s.status = "done";
      task.finishedAt = Date.now();
      this.scheduleSave(true);
      return;
    }

    if (type === "turn.failed" || type === "error") {
      const errObj = (ev.error as Record<string, unknown> | undefined) ?? ev;
      const msg =
        typeof errObj.message === "string"
          ? errObj.message
          : JSON.stringify(errObj);
      task.error = msg;
      task.status = "failed";
      task.phase = "模型返回错误";
      task.finishedAt = Date.now();
      this.appendLog(task, "error", truncateText(msg, 500));
      this.scheduleSave(true);
      return;
    }

    if (
      type === "item.started" ||
      type === "item.updated" ||
      type === "item.completed"
    ) {
      const item = ev.item as Record<string, unknown> | undefined;
      if (!item) return;
      const itemType = String(item.type || "");

      if (itemType === "reasoning") {
        const text = extractTextField(item);
        task.phase = text
          ? `思考: ${truncateText(text.replace(/\s+/g, " "), 55)}`
          : "深度推理中...";
        if (type === "item.completed" && text) {
          this.appendLog(task, "reasoning", truncateText(text, 300));
        }
        this.bumpProgress(task, text);
      } else if (itemType === "command_execution") {
        const cmd =
          typeof item.command === "string"
            ? item.command
            : extractTextField(item);
        const exitCode = item.exit_code;
        task.phase = cmd
          ? `命令: ${truncateText(cmd.replace(/\s+/g, " "), 50)}`
          : "执行终端命令...";
        if (type === "item.started" && cmd) {
          this.appendLog(task, "command", `$ ${truncateText(cmd, 240)}`);
        } else if (type === "item.completed" && exitCode !== undefined) {
          this.appendLog(
            task,
            "command",
            `命令结束 (exit ${String(exitCode)}): ${truncateText(cmd || "", 140)}`,
          );
        }
        this.bumpProgress(task, cmd);
      } else if (itemType === "file_change") {
        const files = extractChangedFiles(item);
        for (const f of files) {
          if (!task.changedFiles.includes(f)) {
            task.changedFiles.push(f);
          }
        }
        if (files.length > 0) {
          const base = path.basename(files[files.length - 1]);
          task.phase = `修改文件: ${base}`;
          this.appendLog(
            task,
            "file",
            `变更文件: ${files.map((f) => path.basename(f)).join(", ")}`,
          );
        } else {
          task.phase = "写入文件变更...";
        }
        this.bumpProgress(task, "");
      } else if (itemType === "mcp_tool_call") {
        const toolName = String(item.tool || item.name || "tool");
        task.phase = `调用工具: ${toolName}`;
        if (type === "item.started") {
          this.appendLog(task, "info", `MCP 工具调用: ${toolName}`);
        }
        this.bumpProgress(task, "");
      } else if (itemType === "agent_message") {
        const text = extractTextField(item);
        if (text) {
          task.finalMessage = text;
          task.phase = "整理输出中...";
          if (type === "item.completed") {
            this.appendLog(
              task,
              "message",
              truncateText(text.replace(/\s+/g, " "), 240),
            );
          }
          this.bumpProgress(task, text);
        }
      } else if (itemType === "error") {
        const msg = extractTextField(item);
        if (msg) {
          this.appendLog(task, "error", truncateText(msg, 400));
        }
      }
      this.scheduleSave();
    }
  }

  private bumpProgress(task: CodexTask, text: string): void {
    if (task.steps.length > 0 && text) {
      const regex = /\[STEP\s+(\d+)\s*\/\s*(\d+)\]/gi;
      let match: RegExpExecArray | null;
      let highestK = 0;
      while ((match = regex.exec(text)) !== null) {
        const k = parseInt(match[1], 10);
        if (Number.isFinite(k) && k > highestK) {
          highestK = k;
        }
      }
      if (highestK > 0) {
        const clampedK = Math.min(task.steps.length, highestK);
        for (let i = 0; i < task.steps.length; i++) {
          if (i < clampedK) task.steps[i].status = "done";
          else if (i === clampedK) task.steps[i].status = "active";
          else task.steps[i].status = "pending";
        }
        const computed = Math.min(
          95,
          Math.round(15 + (clampedK / task.steps.length) * 80),
        );
        task.progress = Math.max(task.progress, computed);
        return;
      }
    }

    if (task.progress < 92) {
      const step = Math.max(2, Math.round((92 - task.progress) * 0.18));
      task.progress = Math.min(92, task.progress + step);
    }
  }

  private appendLog(
    task: CodexTask,
    kind: TaskLogEntry["kind"],
    text: string,
  ): void {
    task.logs.push({ ts: Date.now(), kind, text });
    if (task.logs.length > MAX_LOGS_PER_TASK) {
      task.logs = task.logs.slice(-MAX_LOGS_PER_TASK);
    }
  }

  private cleanupTaskTimer(taskId: string): void {
    const t = this.timers.get(taskId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(taskId);
    }
  }
}

function extractTextField(obj: Record<string, unknown>): string {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.summary === "string") return obj.summary;
  if (Array.isArray(obj.summary)) {
    return obj.summary
      .map((s) =>
        typeof s === "string"
          ? s
          : typeof (s as Record<string, unknown>)?.text === "string"
            ? String((s as Record<string, unknown>).text)
            : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c) =>
        typeof (c as Record<string, unknown>)?.text === "string"
          ? String((c as Record<string, unknown>).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractChangedFiles(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(item.changes)) {
    for (const c of item.changes) {
      if (typeof c === "string") out.push(c);
      else if (c && typeof (c as Record<string, unknown>).path === "string") {
        out.push(String((c as Record<string, unknown>).path));
      }
    }
  }
  if (typeof item.path === "string") out.push(item.path);
  if (typeof item.file === "string") out.push(item.file);
  return out;
}

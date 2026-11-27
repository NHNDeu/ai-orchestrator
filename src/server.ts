import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CodexOrchestrator,
  type CodexTask,
  type DashboardSnapshot,
} from "./codex-runner.js";
import { UuRemoteManager } from "./uu/manager.js";
import { registerUuTools } from "./uu/tools.js";

const APP_URI = "ui://ai-orchestrator/dashboard.html";

function parseDataDirArg(argv: string[]): string {
  for (const arg of argv) {
    if (arg.startsWith("--data-dir=")) {
      const val = arg.slice("--data-dir=".length).trim();
      if (val) return val;
    }
  }
  return path.resolve(__dirname, "..", "data");
}

function loadDashboardHtml(): string {
  const overridePath = process.env.CODEX_ORCHESTRATOR_HTML;
  const htmlPath = overridePath
    ? path.resolve(overridePath)
    : path.join(__dirname, "dashboard.html");
  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html><body><p>Dashboard bundle missing at ${htmlPath}</p></body></html>`;
  }
  return fs.readFileSync(htmlPath, "utf8");
}

function formatSummaryText(snapshot: DashboardSnapshot): string {
  const { summary, environment, settings } = snapshot;
  const q = environment.quota;
  const c = environment.claude;
  const stratLabels: Record<string, string> = {
    "cost-smart": "省钱优先(GPT Plus优先，耗尽切Claude)",
    "quality-first": "质量优先(深度编码Claude，并发/Review用GPT)",
    "codex-only": "仅 GPT",
    "claude-only": "仅 Claude",
  };

  const lines = [
    `AI Orchestrator [GPT: ${environment.codexVersion || "不可用"} (${environment.loggedIn ? "Plus已登录" : environment.loginMessage}) | Claude: ${c.claudeVersion || "不可用"} (${c.summary})]`,
    `GPT额度: ${q.summary} | 健康度: ${q.health} | 可自动调度: ${q.canAutoUse ? "是" : "否"}`,
    `Claude API: ${c.canAutoUse ? "可用" : "受限"} | 今日花费: $${c.dailyCostUsd.toFixed(4)} / ${c.dailyBudgetUsd > 0 ? `$${c.dailyBudgetUsd.toFixed(2)}` : "无上限"} | 单任务上限: ${c.maxTaskBudgetUsd > 0 ? `$${c.maxTaskBudgetUsd.toFixed(2)}` : "无限制"}`,
    `路由策略: ${stratLabels[settings.routingStrategy] || settings.routingStrategy} | 自动编排: ${settings.autoOrchestrate ? "开" : "关"} | 跨引擎容灾: ${settings.autoFallback ? "开" : "关"} | 并发上限: ${settings.maxConcurrency}`,
    `任务统计: 总计 ${summary.total} · 运行中 ${summary.running} · 排队 ${summary.queued} · 完成 ${summary.completed} · 失败 ${summary.failed} · 总进度 ${summary.overallProgress}%${summary.totalCostUsd > 0 ? ` · Claude累计 $${summary.totalCostUsd.toFixed(4)}` : ""}`,
  ];
  if (snapshot.tasks.length > 0) {
    lines.push("", "最近任务:");
    for (const t of snapshot.tasks.slice(0, 12)) {
      const duration = t.startedAt
        ? `${Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000)}s`
        : "-";
      const costPart =
        typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(4)}` : "";
      lines.push(
        `- [${t.id}] [${t.engine.toUpperCase()}] ${t.name} (${t.role}) | ${t.status} ${t.progress}% | ${t.phase} | ${t.model}/${t.effort}${costPart}${t.routeReason ? ` (${t.routeReason})` : ""} | ${duration}`,
      );
    }
  }
  return lines.join("\n");
}

function formatTasksStatusText(
  tasks: CodexTask[],
  includeOutputs = true,
): string {
  if (tasks.length === 0) {
    return "没有匹配的子代理任务。";
  }
  const lines: string[] = [];
  for (const t of tasks) {
    const duration = t.startedAt
      ? `${Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000)}s`
      : "-";
    lines.push(
      `### [${t.id}] [${t.engine.toUpperCase()}] ${t.name} (${t.role}) — ${t.status.toUpperCase()} (${t.progress}%)`,
    );
    lines.push(
      `- 阶段: ${t.phase} | 模型: ${t.model} (${t.effort}) | 沙盒: ${t.mode}${t.worktree ? " + worktree" : ""} | 用时: ${duration}${typeof t.costUsd === "number" ? ` | 费用: $${t.costUsd.toFixed(4)}` : ""}`,
    );
    if (t.threadId) {
      lines.push(`- Session/Thread ID: \`${t.threadId}\``);
    }
    if (t.usage.inputTokens > 0 || t.usage.outputTokens > 0) {
      const cachePct =
        t.usage.inputTokens > 0
          ? Math.round((t.usage.cachedInputTokens / t.usage.inputTokens) * 100)
          : 0;
      lines.push(
        `- Tokens: in=${t.usage.inputTokens} (cache ${cachePct}%), out=${t.usage.outputTokens}, reasoning=${t.usage.reasoningTokens}`,
      );
    }
    if (t.changedFiles.length > 0) {
      lines.push(`- 变更文件: ${t.changedFiles.join(", ")}`);
    }
    if (includeOutputs && t.finalMessage) {
      const preview =
        t.finalMessage.length > 4000
          ? `${t.finalMessage.slice(0, 4000)}\n... (已截断，完整内容见控制台)`
          : t.finalMessage;
      lines.push(`- 输出:\n${preview}`);
    }
    if (t.error) {
      lines.push(`- 错误: ${t.error}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const dataDir = parseDataDirArg(process.argv.slice(2));
  const orchestrator = new CodexOrchestrator(dataDir);
  const uuManager = new UuRemoteManager(dataDir);
  const withUu = (snap: DashboardSnapshot): Record<string, unknown> => ({
    ...(snap as unknown as Record<string, unknown>),
    uu: uuManager.getCachedSnapshot(),
  });

  const server = new McpServer({
    name: "ai-orchestrator",
    version: "2.0.0",
  });

  server.registerResource(
    "ai-orchestrator-dashboard",
    APP_URI,
    {
      title: "AI Orchestrator Dashboard",
      description:
        "Live dual-engine progress-bar dashboard for parallel GPT/Codex and Claude Code subagents",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: "text/html;profile=mcp-app",
          text: loadDashboardHtml(),
        },
      ],
    }),
  );

  // ---------------------------------------------------------------------------
  // Model-facing tools (6 tools, all short names <= 64 chars with prefix)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "open_dashboard",
    {
      title: "AI Orchestrator",
      description:
        "Open or refresh the unified GPT/Codex + Claude Code live progress-bar dashboard in the side pane. Call this whenever starting or monitoring parallel subagents.",
      inputSchema: {
        filterBatchId: z
          .string()
          .optional()
          .describe("Optional batch ID to highlight"),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "AI Orchestrator" },
            { type: "global", title: "AI Orchestrator" },
          ],
        },
      },
    },
    async () => {
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: formatSummaryText(snapshot) }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "dispatch_workers",
    {
      title: "Dispatch GPT / Claude Subagents",
      description:
        "Launch one or more parallel GPT/Codex or Claude Code subagents in the background. When engine/effort are omitted or 'auto', routes by cost-smart / quality-first strategy, live Plus quota, and USD budgets.",
      inputSchema: {
        batchTitle: z
          .string()
          .optional()
          .describe("Short title for this group of subagent tasks"),
        cwd: z
          .string()
          .optional()
          .describe("Default working directory for tasks that omit cwd"),
        respectQuota: z
          .boolean()
          .optional()
          .describe(
            "Check live quota/budget before dispatching (default: true). If both engines are exhausted, returns skippedDueToQuota=true.",
          ),
        tasks: z
          .array(
            z.object({
              name: z.string().describe("Short display name for the worker"),
              prompt: z.string().describe("Clear task instructions"),
              engine: z
                .enum(["auto", "codex", "claude"])
                .optional()
                .describe(
                  "Target engine: 'auto' (default), 'codex' (ChatGPT Plus), or 'claude' (Claude Code Static API)",
                ),
              role: z
                .string()
                .optional()
                .describe("Role label, e.g. 'Backend Coder', 'Code Reviewer'"),
              cwd: z
                .string()
                .optional()
                .describe("Working directory override for this worker"),
              mode: z
                .enum(["read-only", "workspace-write", "review"])
                .optional()
                .describe("Sandbox mode (default: read-only)"),
              worktree: z
                .boolean()
                .optional()
                .describe(
                  "Run in an isolated Git worktree (recommended for parallel workspace-write tasks)",
                ),
              model: z
                .string()
                .optional()
                .describe(
                  "Optional model slug (e.g. gpt-6.2-sol, claude-sonnet-5-5, claude-opus-5-5)",
                ),
              effort: z
                .enum(["auto", "low", "medium", "high", "xhigh"])
                .optional()
                .describe(
                  "Reasoning effort (default 'auto': routes by complexity, quota, and budget)",
                ),
              preset: z
                .enum(["fast", "balanced", "deep"])
                .optional()
                .describe(
                  "Optional explicit tier override: fast=low, balanced=medium, deep=high",
                ),
              steps: z
                .array(z.string())
                .optional()
                .describe(
                  "Ordered milestone labels (3-5 items) to drive accurate progress bar updates",
                ),
              timeoutSec: z
                .number()
                .optional()
                .describe("Per-task timeout in seconds (30-1800)"),
            }),
          )
          .min(1)
          .describe("List of subagent tasks to enqueue"),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
      },
    },
    async (args) => {
      const res = await orchestrator.dispatchBatch(args.tasks, {
        batchTitle: args.batchTitle,
        defaultCwd: args.cwd,
        respectQuota: args.respectQuota,
      });
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      if (res.skippedDueToQuota) {
        return {
          content: [
            {
              type: "text",
              text: `当前双引擎均不可自动调度（GPT: ${res.quota.summary} | Claude: ${res.claude.summary}），已自动跳过派发。请由 Antigravity 原生直接完成此任务。`,
            },
          ],
          structuredContent: {
            ...snapshot,
            skippedDueToQuota: true,
            dispatchedBatchId: "",
            dispatchedTaskIds: [],
          } as unknown as Record<string, unknown>,
        };
      }
      const { batchId, tasks } = res;
      const lines = [
        `已派发 ${tasks.length} 个子代理 (batchId: ${batchId})：`,
        ...tasks.map(
          (t) =>
            `- [${t.id}] [${t.engine.toUpperCase()}] ${t.name} (${t.role}) · ${t.model}/${t.effort} [${t.routeReason || "默认"}] · ${t.mode}${t.worktree ? " + worktree" : ""}`,
        ),
        "",
        "提示：可使用 `workers_status` (设置 waitSec=25) 等待并获取执行结果，或查看右侧实时进度面板。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ...snapshot,
          skippedDueToQuota: false,
          dispatchedBatchId: batchId,
          dispatchedTaskIds: tasks.map((t) => t.id),
        } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "workers_status",
    {
      title: "Get Workers Status",
      description:
        "Poll status, progress bars, changed files, token/USD usage, and final outputs of GPT/Claude subagents. Set waitSec (20-40) to wait efficiently until tasks finish.",
      inputSchema: {
        taskIds: z
          .array(z.string())
          .optional()
          .describe("Optional task IDs to filter"),
        batchId: z.string().optional().describe("Optional batch ID to filter"),
        waitSec: z
          .number()
          .min(0)
          .max(45)
          .optional()
          .describe(
            "Wait up to N seconds (max 45) for watched tasks to complete before returning",
          ),
        includeOutputs: z
          .boolean()
          .optional()
          .describe("Include final agent messages (default: true)"),
      },
    },
    async (args) => {
      const watched = await orchestrator.waitForTasks(
        { taskIds: args.taskIds, batchId: args.batchId },
        args.waitSec ?? 0,
      );
      const snapshot = await orchestrator.getSnapshot({ includeLogs: false });
      return {
        content: [
          {
            type: "text",
            text: formatTasksStatusText(watched, args.includeOutputs ?? true),
          },
        ],
        structuredContent: {
          summary: snapshot.summary,
          watchedTasks: watched.map((t) => ({
            ...t,
            logs: t.logs.slice(-15),
          })),
        } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "resume_worker",
    {
      title: "Resume Worker Session",
      description:
        "Send a follow-up prompt to an existing GPT or Claude worker using its saved session/threadId (preserves history and prompt cache).",
      inputSchema: {
        taskId: z.string().describe("Existing task ID to resume"),
        prompt: z.string().describe("Follow-up instructions for this worker"),
        steps: z
          .array(z.string())
          .optional()
          .describe("Updated milestone labels for this follow-up turn"),
        timeoutSec: z.number().optional().describe("Timeout in seconds"),
      },
      _meta: {
        ui: { visibility: ["model", "app"] },
      },
    },
    async (args) => {
      const task = await orchestrator.resumeTask(args.taskId, args.prompt, {
        steps: args.steps,
        timeoutSec: args.timeoutSec,
      });
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [
          {
            type: "text",
            text: `已恢复子代理 [${task.id}] [${task.engine.toUpperCase()}] ${task.name} (session: ${task.threadId})，当前状态: ${task.status}`,
          },
        ],
        structuredContent: {
          ...snapshot,
          task,
        } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cancel_worker",
    {
      title: "Cancel Worker",
      description:
        "Cancel a queued or running GPT/Claude subagent task (or all active tasks).",
      inputSchema: {
        taskId: z.string().optional().describe("Task ID to cancel"),
        all: z
          .boolean()
          .optional()
          .describe("Set true to cancel all queued and running tasks"),
      },
    },
    async (args) => {
      if (args.all) {
        const count = orchestrator.cancelAllActive();
        return {
          content: [{ type: "text", text: `已取消 ${count} 个活跃子代理任务。` }],
        };
      }
      if (!args.taskId) {
        return {
          isError: true,
          content: [
            { type: "text", text: "请提供 taskId 或设置 all=true。" },
          ],
        };
      }
      const ok = orchestrator.cancelTask(args.taskId);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `已取消任务 ${args.taskId}。`
              : `任务 ${args.taskId} 未在运行或不存在。`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "codex_env",
    {
      title: "Check Codex & Claude Environment",
      description:
        "Inspect local Codex CLI (ChatGPT Plus quota) and Claude Code (Static API status & daily USD spend), available models, and routing settings.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Force re-checking binaries and login status"),
      },
    },
    async (args) => {
      await orchestrator.getEnvironment(Boolean(args.refresh));
      const snapshot = await orchestrator.getSnapshot({ includeLogs: false });
      return {
        content: [{ type: "text", text: formatSummaryText(snapshot) }],
        structuredContent: {
          environment: snapshot.environment,
          settings: snapshot.settings,
          summary: snapshot.summary,
        } as unknown as Record<string, unknown>,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // App-only tools (used exclusively by the MCP App UI)
  // ---------------------------------------------------------------------------

  const APP_ONLY = { ui: { visibility: ["app"] } };

  server.registerTool(
    "app_state",
    {
      title: "App: Get Dashboard State",
      description: "Fetch live orchestrator state for UI polling.",
      inputSchema: {},
      _meta: APP_ONLY,
    },
    async () => {
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "app_cancel",
    {
      title: "App: Cancel Task",
      description: "Cancel a task from the UI.",
      inputSchema: { taskId: z.string() },
      _meta: APP_ONLY,
    },
    async (args) => {
      orchestrator.cancelTask(args.taskId);
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "app_retry",
    {
      title: "App: Retry Task",
      description: "Retry a failed/cancelled task from the UI.",
      inputSchema: { taskId: z.string() },
      _meta: APP_ONLY,
    },
    async (args) => {
      orchestrator.retryTask(args.taskId);
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "app_dispatch",
    {
      title: "App: Dispatch Quick Task",
      description: "Dispatch a single GPT or Claude worker directly from the UI drawer.",
      inputSchema: {
        name: z.string(),
        prompt: z.string(),
        engine: z.enum(["auto", "codex", "claude"]).optional(),
        cwd: z.string().optional(),
        mode: z.enum(["read-only", "workspace-write", "review"]).optional(),
        worktree: z.boolean().optional(),
        model: z.string().optional(),
        effort: z
          .enum(["auto", "low", "medium", "high", "xhigh"])
          .optional(),
        steps: z.array(z.string()).optional(),
      },
      _meta: APP_ONLY,
    },
    async (args) => {
      await orchestrator.dispatchBatch(
        [
          {
            name: args.name,
            prompt: args.prompt,
            engine: args.engine,
            cwd: args.cwd,
            mode: args.mode,
            worktree: args.worktree,
            model: args.model,
            effort: args.effort,
            steps: args.steps,
            role: "Manual Worker",
          },
        ],
        { respectQuota: false },
      );
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "app_settings",
    {
      title: "App: Update Settings",
      description: "Update concurrency, routing strategy, or budgets from the UI.",
      inputSchema: {
        maxConcurrency: z.number().min(1).max(6).optional(),
        defaultModel: z.string().optional(),
        defaultEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        autoRetryOnRateLimit: z.boolean().optional(),
        autoOrchestrate: z.boolean().optional(),
        routingStrategy: z
          .enum(["cost-smart", "quality-first", "codex-only", "claude-only"])
          .optional(),
        claudeDailyBudgetUsd: z.number().min(0).max(1000).optional(),
        claudeMaxTaskBudgetUsd: z.number().min(0).max(200).optional(),
        autoFallback: z.boolean().optional(),
      },
      _meta: APP_ONLY,
    },
    async (args) => {
      orchestrator.updateSettings(args);
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  server.registerTool(
    "app_clear",
    {
      title: "App: Clear Finished Tasks",
      description: "Clear completed, failed, and cancelled tasks from the board.",
      inputSchema: {},
      _meta: APP_ONLY,
    },
    async () => {
      orchestrator.clearFinished();
      const snapshot = await orchestrator.getSnapshot({ includeLogs: true });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: withUu(snapshot),
      };
    },
  );

  registerUuTools(server, uuManager, APP_URI);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    uuManager.shutdown();
  };
  process.stdin.on("end", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `[ai-orchestrator] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});

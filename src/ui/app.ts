import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import type {
  CodexTask,
  DashboardSnapshot,
  RoutingStrategy,
} from "../codex-runner.js";
import type { UuShell, UuSnapshot } from "../uu/types.js";
import {
  renderRemoteSidebarBody,
  renderRemoteStage,
} from "./remote-view.js";

type DashboardSnapshotWithUu = DashboardSnapshot & {
  uu?: UuSnapshot;
};

const app = new App({ name: "AI Orchestrator", version: "2.0.0" }, {});

let snapshot: DashboardSnapshotWithUu | null = null;
let selectedTaskId: string | null = null;
let composeNewMode = false;
let viewMode: "tasks" | "remote" = "tasks";
let selectedUuDeviceId: string | null = null;
let selectedUuSession = "orch-default";
let uuBusy = false;
let filterTab: "all" | "active" | "done" = "all";
let expandedSteps = new Set<string>();
let collapsedSteps = new Set<string>();
let expandedPrompts = new Set<string>();
let pollInFlight = false;
let pollTimer: number | null = null;
let clockDriftMs = 0;
let canSendMessage = false;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(raw: string): string {
  const codeBlocks: string[] = [];
  let text = raw.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre><code>${escapeHtml(String(code).trimEnd())}</code></pre>`);
      return `@@CODEBLOCK_${idx}@@`;
    },
  );

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^@@CODEBLOCK_(\d+)@@$/.test(trimmed)) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const idx = Number(trimmed.match(/\d+/)?.[0] ?? 0);
      out.push(codeBlocks[idx] ?? "");
      continue;
    }
    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${hMatch[2]}</h${lvl}>`);
      continue;
    }
    const liMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (liMatch) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${liMatch[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (trimmed === "") {
      out.push("");
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");

  return out.join("\n").replace(/@@CODEBLOCK_(\d+)@@/g, (_m, n) => codeBlocks[Number(n)] ?? "");
}

function formatDuration(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return "等待中";
  const end = finishedAt ?? Date.now() + clockDriftMs;
  const sec = Math.max(0, Math.round((end - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatReset(ts: number | null, withDate = false): string {
  if (!ts) return "未知";
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (!withDate) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

function statusLabel(status: CodexTask["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function toFileUri(cwd: string, filePath: string): string {
  const abs = /^[a-zA-Z]:[\\/]|^\//.test(filePath)
    ? filePath
    : `${cwd.replace(/[\\/]+$/, "")}/${filePath}`;
  const normalized = abs.replace(/\\/g, "/");
  return normalized.startsWith("/")
    ? `file://${normalized}`
    : `file:///${normalized}`;
}

function filteredTasks(tasks: CodexTask[]): CodexTask[] {
  if (filterTab === "active") {
    return tasks.filter((t) => t.status === "running" || t.status === "queued");
  }
  if (filterTab === "done") {
    return tasks.filter(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled",
    );
  }
  return tasks;
}

function isStepsExpanded(t: CodexTask): boolean {
  if (expandedSteps.has(t.id)) return true;
  if (collapsedSteps.has(t.id)) return false;
  return t.status === "running" || t.status === "failed";
}

function renderSidebarThread(t: CodexTask): string {
  const isActive = !composeNewMode && t.id === selectedTaskId;
  const elapsed = formatDuration(t.startedAt, t.finishedAt);
  const eng = t.engine === "claude" ? "Claude" : "GPT";
  const costStr = typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(2)}` : "";

  return `
    <button class="thread-item ${isActive ? "active" : ""}" data-select-id="${escapeHtml(t.id)}">
      <div class="thread-top">
        <div class="thread-name-wrap">
          <span class="dot ${t.status}"></span>
          <span class="thread-title">${escapeHtml(t.name)}</span>
        </div>
        <span class="engine-badge ${t.engine}">${eng}</span>
      </div>
      <div class="mini-bar">
        <div class="mini-bar-fill ${t.status}" style="width:${t.progress}%"></div>
      </div>
      <div class="thread-meta">
        <span>${escapeHtml(t.model)} · ${t.progress}%</span>
        <span data-timer-id="${escapeHtml(t.id)}">${elapsed}${costStr}</span>
      </div>
    </button>
  `;
}

function renderSidebar(snap: DashboardSnapshotWithUu): string {
  const { environment, settings, summary, tasks, uu } = snap;
  const pendingCount = uu?.pending?.length ?? 0;
  const switcherHtml = `
    <div class="filter-tabs">
      <button class="filter-tab ${viewMode === "tasks" ? "active" : ""}" data-view-mode="tasks">任务 (${summary.total})</button>
      <button class="filter-tab ${viewMode === "remote" ? "active" : ""}" data-view-mode="remote">远程${pendingCount > 0 ? ` (${pendingCount}待批)` : ""}</button>
    </div>
  `;

  if (viewMode === "remote") {
    return `
      <aside class="sidebar">
        <div class="brand-row">
          <div class="brand-title">
            <span class="brand-dot"></span>
            <span>AI Orchestrator</span>
          </div>
          <button id="newThreadBtn" class="new-thread-btn">+ 新建任务</button>
        </div>
        ${switcherHtml}
        ${renderRemoteSidebarBody(uu, selectedUuDeviceId, selectedUuSession)}
      </aside>
    `;
  }

  const visible = filteredTasks(tasks);
  const activeList = visible.filter(
    (t) => t.status === "running" || t.status === "queued",
  );
  const historyList = visible.filter(
    (t) => t.status !== "running" && t.status !== "queued",
  );

  const q = environment.quota;
  const claude = environment.claude;
  const barCls = (rem: number) => (rem >= 50 ? "ok" : rem >= 20 ? "warn" : "err");
  const claudePct =
    claude && claude.dailyBudgetUsd > 0
      ? Math.min(100, Math.round((claude.dailyCostUsd / claude.dailyBudgetUsd) * 100))
      : 0;

  return `
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-title">
          <span class="brand-dot"></span>
          <span>AI Orchestrator</span>
        </div>
        <button id="newThreadBtn" class="new-thread-btn ${composeNewMode ? "active" : ""}">+ 新建任务</button>
      </div>

      ${switcherHtml}

      <div class="filter-tabs">
        <button class="filter-tab ${filterTab === "all" ? "active" : ""}" data-filter="all">全部 (${summary.total})</button>
        <button class="filter-tab ${filterTab === "active" ? "active" : ""}" data-filter="active">运行 (${summary.running + summary.queued})</button>
        <button class="filter-tab ${filterTab === "done" ? "active" : ""}" data-filter="done">历史 (${summary.completed + summary.failed + summary.cancelled})</button>
      </div>

      <div class="thread-list">
        ${
          visible.length === 0
            ? `<div style="padding:12px 6px;font-size:11px;color:var(--cx-muted)">暂无会话</div>`
            : `${
                activeList.length > 0
                  ? `<div class="thread-group-label">活跃中</div>${activeList.map(renderSidebarThread).join("")}`
                  : ""
              }${
                historyList.length > 0
                  ? `<div class="thread-group-label">历史会话</div>${historyList.map(renderSidebarThread).join("")}`
                  : ""
              }`
        }
      </div>

      <div class="sidebar-footer">
        ${
          q?.primary
            ? `<div class="quota-mini-row" title="重置 ${formatReset(q.primary.resetsAt)}">
                <span>GPT 5h <strong>${q.primary.remainingPercent}%</strong></span>
                <div class="quota-mini-track"><div class="quota-mini-fill ${barCls(q.primary.remainingPercent)}" style="width:${q.primary.remainingPercent}%"></div></div>
              </div>`
            : ""
        }
        ${
          q?.secondary
            ? `<div class="quota-mini-row" title="重置 ${formatReset(q.secondary.resetsAt, true)}">
                <span>GPT 7天 <strong>${q.secondary.remainingPercent}%</strong></span>
                <div class="quota-mini-track"><div class="quota-mini-fill ${barCls(q.secondary.remainingPercent)}" style="width:${q.secondary.remainingPercent}%"></div></div>
              </div>`
            : ""
        }
        ${
          claude
            ? `<div class="quota-mini-row" title="${claude.maxTaskBudgetUsd > 0 ? `单任务上限 $${claude.maxTaskBudgetUsd.toFixed(2)}` : "单任务上限: 无限制"}">
                <span>Claude <strong>$${claude.dailyCostUsd.toFixed(2)}</strong>${claude.dailyBudgetUsd > 0 ? `/$${claude.dailyBudgetUsd.toFixed(1)}` : " · 无上限"}</span>
                <div class="quota-mini-track"><div class="quota-mini-fill ${claude.dailyBudgetUsd > 0 ? barCls(100 - claudePct) : "ok"}" style="width:${claude.dailyBudgetUsd > 0 ? claudePct : 100}%"></div></div>
              </div>`
            : ""
        }
        <div class="sidebar-controls">
          <select id="strategySelect" class="select-compact" style="flex:1">
            <option value="cost-smart" ${settings.routingStrategy === "cost-smart" ? "selected" : ""}>省钱优先</option>
            <option value="quality-first" ${settings.routingStrategy === "quality-first" ? "selected" : ""}>质量优先</option>
            <option value="codex-only" ${settings.routingStrategy === "codex-only" ? "selected" : ""}>仅 GPT</option>
            <option value="claude-only" ${settings.routingStrategy === "claude-only" ? "selected" : ""}>仅 Claude</option>
          </select>
          <select id="concurrencySelect" class="select-compact" title="最大并发">
            ${[1, 2, 3, 4, 5, 6]
              .map(
                (n) =>
                  `<option value="${n}" ${settings.maxConcurrency === n ? "selected" : ""}>${n}并发</option>`,
              )
              .join("")}
          </select>
          <button id="toggleAutoBtn" class="btn ${settings.autoOrchestrate ? "primary" : ""}" style="padding:2px 7px">
            ${settings.autoOrchestrate ? "自动:开" : "自动:关"}
          </button>
          ${
            summary.completed + summary.failed + summary.cancelled > 0
              ? `<button id="clearBtn" class="btn subtle" style="padding:2px 6px" title="清理已完成">清理</button>`
              : ""
          }
        </div>
      </div>
    </aside>
  `;
}

function renderNewTaskStage(snap: DashboardSnapshot): string {
  const { environment } = snap;
  const claude = environment.claude;
  const allModels = [
    `<option value="">模型: 自动匹配</option>`,
    ...environment.models.map(
      (m) =>
        `<option value="${escapeHtml(m.slug)}">[GPT] ${escapeHtml(m.displayName)}</option>`,
    ),
    ...(claude?.availableModels ?? []).map(
      (m) =>
        `<option value="${escapeHtml(m.slug)}">[Claude] ${escapeHtml(m.displayName)}</option>`,
    ),
  ].join("");

  return `
    <main class="stage">
      <div class="stage-header">
        <div class="stage-title-group">
          <h1 class="stage-title">新建子代理任务</h1>
          <span class="pill ${environment.loggedIn ? "ok" : "warn"}">GPT Plus ${environment.loggedIn ? "在线" : "未登录"}</span>
          <span class="pill ${claude?.canAutoUse ? "ok" : "warn"}">Claude API ${claude?.canAutoUse ? "在线" : "受限"}</span>
        </div>
        <button id="refreshBtn" class="btn subtle">刷新状态</button>
      </div>

      <div class="welcome-stage">
        <div class="welcome-hero">
          <h2>把任务交给 GPT / Claude 子代理</h2>
          <p>默认采用「${snap.settings.routingStrategy === "quality-first" ? "质量优先" : "省钱优先"}」策略，自动匹配模型与推理档位，并实时回传步骤与命令执行轨迹。</p>
        </div>

        <div class="prompt-presets">
          <button class="preset-chip" data-preset="梳理当前项目目录结构、核心入口和主要模块职责，给出简明概览" data-mode="read-only" data-name="项目结构调研">🔍 项目结构调研</button>
          <button class="preset-chip" data-preset="审查当前仓库近期改动，重点检查边界条件、错误处理和并发隐患" data-mode="review" data-name="代码 Review">🛡️ 代码 Review</button>
          <button class="preset-chip" data-preset="检查工程依赖、配置脚本与潜在构建风险，给出改进建议" data-mode="read-only" data-name="配置健康巡检">⚙️ 配置健康巡检</button>
        </div>

        <div class="composer-box">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="qName" type="text" placeholder="任务名称（如：模块调研）" value="AI Worker" style="flex:1;min-width:120px;border:1px solid var(--cx-border);background:var(--cx-surface-2);border-radius:6px;padding:4px 8px" />
            <input id="qCwd" type="text" placeholder="工作目录 cwd（留空使用默认）" style="flex:1.5;min-width:160px;border:1px solid var(--cx-border);background:var(--cx-surface-2);border-radius:6px;padding:4px 8px" />
          </div>
          <textarea id="qPrompt" rows="4" placeholder="描述你想让 GPT 或 Claude 执行的任务...（Ctrl+Enter 发送）"></textarea>
          <input id="qSteps" type="text" placeholder="可选里程碑（用逗号分隔，例如：阅读源码, 定位问题, 给出方案）" style="border:1px solid var(--cx-border);background:var(--cx-surface-2);border-radius:6px;padding:4px 8px" />
          <div class="composer-toolbar">
            <div class="composer-pills">
              <select id="qEngine" class="select-compact">
                <option value="auto" selected>引擎: 自动</option>
                <option value="codex">GPT (Plus)</option>
                <option value="claude">Claude (API)</option>
              </select>
              <select id="qModel" class="select-compact">${allModels}</select>
              <select id="qEffort" class="select-compact">
                <option value="auto" selected>档位: 自动</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <select id="qMode" class="select-compact">
                <option value="read-only">只读</option>
                <option value="review">Review</option>
                <option value="workspace-write">可改文件</option>
              </select>
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--cx-muted)">
                <input id="qWorktree" type="checkbox" /> Worktree
              </label>
            </div>
            <button id="submitQuickBtn" class="btn primary">派发任务</button>
          </div>
        </div>
      </div>
    </main>
  `;
}

function renderThreadStage(t: CodexTask): string {
  const elapsed = formatDuration(t.startedAt, t.finishedAt);
  const cachePct =
    t.usage.inputTokens > 0
      ? Math.round((t.usage.cachedInputTokens / t.usage.inputTokens) * 100)
      : 0;
  const stepsOpen = isStepsExpanded(t);
  const promptLong = t.prompt.length > 260;
  const promptOpen = expandedPrompts.has(t.id);
  const promptShown =
    promptLong && !promptOpen ? `${t.prompt.slice(0, 260)}...` : t.prompt;
  const canResume =
    Boolean(t.threadId) &&
    t.status !== "running" &&
    t.status !== "queued";

  return `
    <main class="stage">
      <div class="stage-header">
        <div class="stage-title-group">
          <span class="dot ${t.status}"></span>
          <span class="engine-badge ${t.engine}">${t.engine === "claude" ? "Claude" : "GPT"}</span>
          <h1 class="stage-title">${escapeHtml(t.name)}</h1>
          <span class="pill">${escapeHtml(t.model)} · ${escapeHtml(t.effort)}</span>
          <span class="pill">${escapeHtml(t.mode)}${t.worktree ? " + worktree" : ""}</span>
          ${t.autoRouted ? `<span class="pill" title="${escapeHtml(t.routeReason || "")}">自动路由</span>` : ""}
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${
            t.status === "running" || t.status === "queued"
              ? `<button class="btn danger" data-action="cancel" data-id="${escapeHtml(t.id)}">停止</button>`
              : ""
          }
          ${
            t.status === "failed" || t.status === "cancelled"
              ? `<button class="btn" data-action="retry" data-id="${escapeHtml(t.id)}">重试</button>`
              : ""
          }
          ${
            t.status === "completed" && canSendMessage
              ? `<button class="btn primary" data-action="send" data-id="${escapeHtml(t.id)}">发给指挥官</button>`
              : ""
          }
          <button id="refreshBtn" class="btn subtle">刷新</button>
        </div>
      </div>

      <div class="progress-banner">
        <div class="progress-row">
          <div class="progress-track">
            <div class="progress-fill ${t.status}" style="width:${t.progress}%"></div>
          </div>
          <span style="font-weight:700;font-variant-numeric:tabular-nums;min-width:34px;text-align:right">${t.progress}%</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--cx-muted);flex-wrap:wrap">
          <span>${statusLabel(t.status)} · ${escapeHtml(t.phase)}</span>
          <span style="font-variant-numeric:tabular-nums">
            <span data-timer-id="${escapeHtml(t.id)}">${elapsed}</span> · in ${formatTokens(t.usage.inputTokens)} (${cachePct}% cache) / out ${formatTokens(t.usage.outputTokens)}${typeof t.costUsd === "number" ? ` · $${t.costUsd.toFixed(4)}` : ""}
          </span>
        </div>
        ${
          t.steps.length > 0
            ? `<div class="steps-row">
                ${t.steps
                  .map((s) => {
                    const icon =
                      s.status === "done"
                        ? "✓"
                        : s.status === "active"
                          ? "●"
                          : "○";
                    return `<span class="step-chip ${s.status}">${icon} ${escapeHtml(s.label)}</span>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
      </div>

      <div class="timeline" id="timelineScroll">
        <div class="prompt-bubble">
          ${escapeHtml(promptShown)}
          ${
            promptLong
              ? `<div style="margin-top:4px"><button class="btn subtle" data-action="toggle-prompt" data-id="${escapeHtml(t.id)}" style="padding:1px 6px;font-size:10.5px">${promptOpen ? "收起指令" : "展开完整指令"}</button></div>`
              : ""
          }
        </div>

        <section class="steps-panel">
          <button class="steps-panel-head" data-action="toggle-steps" data-id="${escapeHtml(t.id)}">
            <span>Steps &amp; Commands · ${t.logs.length} 条记录${t.changedFiles.length > 0 ? ` · ${t.changedFiles.length} 个变更文件` : ""}</span>
            <span>${stepsOpen ? "收起 ▾" : "展开 ▸"}</span>
          </button>
          ${
            stepsOpen
              ? `<div class="steps-panel-body">
                  ${
                    t.routeReason
                      ? `<div class="step-row info"><span class="ts">路由</span><span class="txt">${escapeHtml(t.routeReason)}</span></div>`
                      : ""
                  }
                  ${
                    t.logs.length === 0
                      ? `<div class="step-row"><span class="txt" style="color:var(--cx-muted)">等待事件输出...</span></div>`
                      : t.logs
                          .map(
                            (l) =>
                              `<div class="step-row ${l.kind}"><span class="ts">${new Date(l.ts).toLocaleTimeString()}</span><span class="txt">${escapeHtml(l.text)}</span></div>`,
                          )
                          .join("")
                  }
                </div>`
              : ""
          }
        </section>

        ${
          t.error
            ? `<div class="error-banner"><strong>执行异常：</strong>${escapeHtml(t.error)}</div>`
            : ""
        }

        ${
          t.finalMessage || t.changedFiles.length > 0
            ? `<section class="assistant-card">
                ${
                  t.finalMessage
                    ? `<div class="md-body">${renderMarkdown(t.finalMessage)}</div>`
                    : `<div style="color:var(--cx-muted);font-size:12px">已产生文件变更，等待最终总结...</div>`
                }
                ${
                  t.changedFiles.length > 0
                    ? `<div class="file-chips">
                        ${t.changedFiles
                          .map(
                            (f) =>
                              `<button class="file-chip" data-action="open-file" data-cwd="${escapeHtml(t.cwd)}" data-file="${escapeHtml(f)}" title="${escapeHtml(f)}">M ${escapeHtml(f.split(/[\\/]/).pop() || f)}</button>`,
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </section>`
            : t.status === "running" || t.status === "queued"
              ? `<div style="color:var(--cx-muted);font-size:12px;padding:6px 2px">子代理正在工作中，输出将实时显示在这里...</div>`
              : ""
        }
      </div>

      ${
        canResume
          ? `<div class="composer-dock">
              <div class="composer-box">
                <textarea id="followupInput" rows="2" placeholder="向这个 ${t.engine === "claude" ? "Claude" : "GPT"} 会话继续追问或要求修改...（Enter 发送，Shift+Enter 换行）"></textarea>
                <div class="composer-toolbar">
                  <span style="font-size:11px;color:var(--cx-muted)">复用 Session: <code>${escapeHtml(t.threadId!.slice(0, 12))}…</code></span>
                  <button id="sendFollowupBtn" class="btn primary" data-id="${escapeHtml(t.id)}">续接发送</button>
                </div>
              </div>
            </div>`
          : ""
      }
    </main>
  `;
}

function render(): void {
  const root = document.getElementById("root");
  if (!root) return;

  if (!snapshot) {
    root.innerHTML = `<div class="welcome-stage"><div class="welcome-hero"><h2>正在连接 AI Orchestrator...</h2></div></div>`;
    return;
  }

  if (snapshot.tasks.length === 0) {
    composeNewMode = true;
    selectedTaskId = null;
  } else if (
    !composeNewMode &&
    (!selectedTaskId || !snapshot.tasks.some((t) => t.id === selectedTaskId))
  ) {
    selectedTaskId = snapshot.tasks[0].id;
  }

  if (snapshot.uu && snapshot.uu.devices.length > 0) {
    if (
      !selectedUuDeviceId ||
      !snapshot.uu.devices.some((d) => d.deviceId === selectedUuDeviceId)
    ) {
      const online = snapshot.uu.devices.find((d) => d.isOnline);
      selectedUuDeviceId = (online || snapshot.uu.devices[0]).deviceId;
    }
  }

  const activeTask =
    !composeNewMode && selectedTaskId
      ? snapshot.tasks.find((t) => t.id === selectedTaskId) ?? null
      : null;

  const sidebarHtml = renderSidebar(snapshot);
  const stageHtml =
    viewMode === "remote"
      ? renderRemoteStage(snapshot.uu, selectedUuDeviceId, selectedUuSession, uuBusy)
      : activeTask
        ? renderThreadStage(activeTask)
        : renderNewTaskStage(snapshot);

  root.innerHTML = `<div class="workspace">${sidebarHtml}${stageHtml}</div>`;
  bindEvents();
}

function bindEvents(): void {
  document.getElementById("newThreadBtn")?.addEventListener("click", () => {
    viewMode = "tasks";
    composeNewMode = true;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-view-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = (btn.dataset.viewMode as "tasks" | "remote") || "tasks";
      viewMode = next;
      render();
      if (next === "remote") {
        void callAppTool("app_uu_state", { refresh: true });
      }
    });
  });

  // Remote view event bindings
  document.getElementById("uuRefreshBtn")?.addEventListener("click", () => {
    void callAppTool("app_uu_act", {
      op: "refresh",
      deviceId: selectedUuDeviceId || undefined,
    });
  });
  document.getElementById("uuStageRefreshBtn")?.addEventListener("click", () => {
    void callAppTool("app_uu_act", {
      op: "refresh",
      deviceId: selectedUuDeviceId || undefined,
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-uu-device]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedUuDeviceId = btn.dataset.uuDevice || null;
      render();
      if (selectedUuDeviceId) {
        void callAppTool("app_uu_act", {
          op: "refresh",
          deviceId: selectedUuDeviceId,
        });
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-uu-session]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedUuSession = btn.dataset.uuSession || "orch-default";
      render();
    });
  });

  document.getElementById("uuNewSessionBtn")?.addEventListener("click", async () => {
    if (!selectedUuDeviceId) return;
    const name = `orch-${Date.now().toString(36).slice(-4)}`;
    selectedUuSession = name;
    await callAppTool("app_uu_act", {
      op: "new",
      deviceId: selectedUuDeviceId,
      session: name,
    });
  });

  document.getElementById("uuToggleEnabledBtn")?.addEventListener("click", async () => {
    const cur = Boolean(snapshot?.uu?.settings.enabled);
    await callAppTool("app_uu_settings", { enabled: !cur });
  });

  document.getElementById("uuToggleReadOnlyBtn")?.addEventListener("click", async () => {
    const cur = Boolean(snapshot?.uu?.settings.readOnly);
    await callAppTool("app_uu_settings", { readOnly: !cur });
  });

  document.getElementById("uuToggleSkipConfirmBtn")?.addEventListener("click", async () => {
    const cur = Boolean(snapshot?.uu?.settings.skipConfirmForAllowlist);
    await callAppTool("app_uu_settings", { skipConfirmForAllowlist: !cur });
  });

  document
    .getElementById("uuConfirmModeSelect")
    ?.addEventListener("change", async (e) => {
      const val = (e.target as HTMLSelectElement).value as
        | "allowlist"
        | "always"
        | "off";
      await callAppTool("app_uu_settings", { confirmMode: val });
    });

  document.getElementById("uuToggleAllowBtn")?.addEventListener("click", async (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.deviceId;
    if (id) await callAppTool("app_uu_act", { op: "toggle_allow", deviceId: id });
  });

  document.getElementById("uuKillSessionBtn")?.addEventListener("click", async (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.deviceId;
    if (id) {
      await callAppTool("app_uu_act", {
        op: "kill",
        deviceId: id,
        session: selectedUuSession,
      });
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-uu-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.uuAct;
      const pendingId = btn.dataset.pendingId;
      if (!pendingId) return;
      if (act === "approve") {
        await callAppTool("app_uu_act", { op: "approve", pendingId });
      } else if (act === "approve-allow") {
        await callAppTool("app_uu_act", {
          op: "approve",
          pendingId,
          alsoAllowDevice: true,
        });
      } else if (act === "reject") {
        await callAppTool("app_uu_act", { op: "reject", pendingId });
      }
    });
  });

  const runUuCommand = async () => {
    if (!selectedUuDeviceId || uuBusy) return;
    const input = document.getElementById("uuCmdInput") as HTMLTextAreaElement | null;
    const cmd = input?.value.trim() || "";
    if (!cmd) return;
    const shell =
      ((document.getElementById("uuShellSelect") as HTMLSelectElement | null)
        ?.value as UuShell) || "powershell";
    const sess =
      (document.getElementById("uuSessionInput") as HTMLInputElement | null)?.value.trim() ||
      selectedUuSession;
    selectedUuSession = sess;
    if (input) input.value = "";
    uuBusy = true;
    render();
    try {
      await callAppTool("app_uu_act", {
        op: "exec",
        deviceId: selectedUuDeviceId,
        session: sess,
        shell,
        command: cmd,
      });
    } finally {
      uuBusy = false;
      render();
    }
  };

  document.getElementById("uuRunCmdBtn")?.addEventListener("click", () => {
    void runUuCommand();
  });
  document.getElementById("uuCmdInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runUuCommand();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterTab = (btn.dataset.filter as "all" | "active" | "done") || "all";
      render();
    });
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-select-id]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTaskId = btn.dataset.selectId || null;
        composeNewMode = false;
        render();
      });
    });

  document
    .getElementById("strategySelect")
    ?.addEventListener("change", async (e) => {
      const val = (e.target as HTMLSelectElement).value as RoutingStrategy;
      await callAppTool("app_settings", { routingStrategy: val });
    });

  document
    .getElementById("concurrencySelect")
    ?.addEventListener("change", async (e) => {
      const val = Number((e.target as HTMLSelectElement).value);
      await callAppTool("app_settings", { maxConcurrency: val });
    });

  document
    .getElementById("toggleAutoBtn")
    ?.addEventListener("click", async () => {
      const current = Boolean(snapshot?.settings.autoOrchestrate);
      await callAppTool("app_settings", { autoOrchestrate: !current });
    });

  document.getElementById("clearBtn")?.addEventListener("click", () => {
    void callAppTool("app_clear", {});
  });

  document.getElementById("refreshBtn")?.addEventListener("click", () => {
    void pollOnce();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const promptEl = document.getElementById("qPrompt") as HTMLTextAreaElement | null;
      const nameEl = document.getElementById("qName") as HTMLInputElement | null;
      const modeEl = document.getElementById("qMode") as HTMLSelectElement | null;
      if (promptEl) promptEl.value = btn.dataset.preset || "";
      if (nameEl && btn.dataset.name) nameEl.value = btn.dataset.name;
      if (modeEl && btn.dataset.mode) modeEl.value = btn.dataset.mode;
      promptEl?.focus();
    });
  });

  const submitNewTask = async () => {
    const engine =
      ((document.getElementById("qEngine") as HTMLSelectElement | null)
        ?.value as "auto" | "codex" | "claude") || "auto";
    const name =
      (document.getElementById("qName") as HTMLInputElement | null)?.value.trim() ||
      "AI Worker";
    const cwd =
      (document.getElementById("qCwd") as HTMLInputElement | null)?.value.trim() ||
      undefined;
    const model =
      (document.getElementById("qModel") as HTMLSelectElement | null)?.value ||
      undefined;
    const effort =
      ((document.getElementById("qEffort") as HTMLSelectElement | null)
        ?.value as "auto" | "low" | "medium" | "high" | "xhigh") || "auto";
    const mode =
      ((document.getElementById("qMode") as HTMLSelectElement | null)?.value as
        | "read-only"
        | "workspace-write"
        | "review") || "read-only";
    const prompt =
      (
        document.getElementById("qPrompt") as HTMLTextAreaElement | null
      )?.value.trim() || "";
    const stepsRaw =
      (document.getElementById("qSteps") as HTMLInputElement | null)?.value ||
      "";
    const worktree = Boolean(
      (document.getElementById("qWorktree") as HTMLInputElement | null)
        ?.checked,
    );

    if (!prompt) return;
    const steps = stepsRaw
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    composeNewMode = false;
    selectedTaskId = null;
    await callAppTool("app_dispatch", {
      name,
      prompt,
      engine,
      cwd,
      mode,
      worktree,
      model,
      effort,
      steps: steps.length > 0 ? steps : undefined,
    });
  };

  document
    .getElementById("submitQuickBtn")
    ?.addEventListener("click", () => void submitNewTask());

  document
    .getElementById("qPrompt")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submitNewTask();
      }
    });

  const submitFollowup = async (taskId: string) => {
    const input = document.getElementById("followupInput") as HTMLTextAreaElement | null;
    const text = input?.value.trim() || "";
    if (!text) return;
    if (input) input.value = "";
    await callAppTool("resume_worker", { taskId, prompt: text });
  };

  document
    .getElementById("sendFollowupBtn")
    ?.addEventListener("click", (e) => {
      const id = (e.currentTarget as HTMLButtonElement).dataset.id || "";
      if (id) void submitFollowup(id);
    });

  document
    .getElementById("followupInput")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const id = selectedTaskId || "";
        if (id) void submitFollowup(id);
      }
    });

  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id || "";
      if (action === "toggle-steps") {
        const task = snapshot?.tasks.find((x) => x.id === id);
        if (!task) return;
        if (isStepsExpanded(task)) {
          expandedSteps.delete(id);
          collapsedSteps.add(id);
        } else {
          collapsedSteps.delete(id);
          expandedSteps.add(id);
        }
        render();
      } else if (action === "toggle-prompt") {
        if (expandedPrompts.has(id)) expandedPrompts.delete(id);
        else expandedPrompts.add(id);
        render();
      } else if (action === "cancel") {
        await callAppTool("app_cancel", { taskId: id });
      } else if (action === "retry") {
        await callAppTool("app_retry", { taskId: id });
      } else if (action === "send") {
        const task = snapshot?.tasks.find((t) => t.id === id);
        if (task && canSendMessage) {
          await app.sendMessage({
            role: "user",
            content: [
              {
                type: "text",
                text: `[${task.engine.toUpperCase()}] 子代理 [${task.id}] ${task.name} 已完成，请查看其输出并汇总下一步：\n\n${task.finalMessage || "(无输出)"}`,
              },
            ],
          });
        }
      } else if (action === "open-file") {
        const cwd = btn.dataset.cwd || "";
        const file = btn.dataset.file || "";
        const uri = toFileUri(cwd, file);
        try {
          await app.request(
            {
              method: "com.google.antigravity/toggle-aux-pane",
              params: { tabType: "fileView", uri },
            },
            z.object({ isError: z.boolean().optional() }).passthrough(),
          );
        } catch {
          // Ignore -32601 on unsupported surfaces
        }
      }
    });
  });
}

async function callAppTool(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (pollInFlight && name === "app_state") return;
  if (name === "app_state") pollInFlight = true;
  try {
    const res = await app.callServerTool({ name, arguments: args });
    if (res.structuredContent) {
      applySnapshot(res.structuredContent as Record<string, unknown>);
    }
  } catch {
    // Back off silently
  } finally {
    if (name === "app_state") pollInFlight = false;
  }
}

function applySnapshot(next: Record<string, unknown>): void {
  if (!next) return;
  if (Array.isArray((next as unknown as DashboardSnapshot).tasks)) {
    const full = next as unknown as DashboardSnapshotWithUu;
    if (typeof full.serverTime === "number") {
      clockDriftMs = full.serverTime - Date.now();
    }
    snapshot = full;
  } else if ("uu" in next && next.uu && snapshot) {
    snapshot = {
      ...snapshot,
      uu: next.uu as UuSnapshot,
    };
  } else {
    return;
  }

  const activeEl = document.activeElement;
  if (
    activeEl &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName)
  ) {
    return;
  }
  render();
  scheduleNextPoll();
}

function scheduleNextPoll(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (document.hidden) return;
  const hasActive =
    snapshot &&
    (snapshot.summary.running > 0 || snapshot.summary.queued > 0);
  const delay = hasActive ? 1200 : 5000;
  pollTimer = window.setTimeout(() => {
    void pollOnce();
  }, delay);
}

async function pollOnce(): Promise<void> {
  if (document.hidden) return;
  await callAppTool("app_state", {});
  scheduleNextPoll();
}

function tickTimers(): void {
  if (!snapshot) return;
  for (const t of snapshot.tasks) {
    if (t.status !== "running") continue;
    document
      .querySelectorAll<HTMLElement>(`[data-timer-id="${CSS.escape(t.id)}"]`)
      .forEach((el) => {
        el.textContent = formatDuration(t.startedAt, t.finishedAt);
      });
  }
}

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applySnapshot(result.structuredContent as Record<string, unknown>);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  render();
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  canSendMessage = Boolean(app.getHostCapabilities()?.message);

  await pollOnce();
  window.setInterval(tickTimers, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollOnce();
  });
}

void init();

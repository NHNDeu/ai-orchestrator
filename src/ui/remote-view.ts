import type {
  UuAuditEntry,
  UuDeviceInfo,
  UuPendingRequest,
  UuShell,
  UuSnapshot,
} from "../uu/types.js";

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function platformTag(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("darwin")) return "Mac";
  if (p.includes("linux")) return "Linux";
  return "Win";
}

function defaultShell(platform: string): UuShell {
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("darwin")) return "zsh";
  if (p.includes("linux")) return "bash";
  return "powershell";
}

function decisionLabel(d: UuAuditEntry["decision"]): { text: string; cls: string } {
  switch (d) {
    case "allowed":
      return { text: "已执行", cls: "ok" };
    case "approved":
      return { text: "已批准", cls: "ok" };
    case "pending":
      return { text: "待审批", cls: "warn" };
    case "rejected":
      return { text: "已拒绝", cls: "err" };
    case "denied":
      return { text: "已拦截", cls: "err" };
    case "timeout":
      return { text: "超时", cls: "err" };
    case "failed":
      return { text: "失败", cls: "err" };
  }
}

export function renderRemoteSidebarBody(
  uu: UuSnapshot | undefined,
  selectedDeviceId: string | null,
  selectedSession: string,
): string {
  if (!uu) {
    return `
      <div class="thread-list">
        <div style="padding:12px 6px;font-size:11px;color:var(--cx-muted)">正在探测 UU 远程状态...</div>
      </div>
    `;
  }

  const devices = uu.devices || [];
  const activeDev =
    devices.find((d) => d.deviceId === selectedDeviceId) || devices[0] || null;
  const sessions = activeDev
    ? uu.sessionsByDevice[activeDev.deviceId] || []
    : [];

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;padding:0 2px">
      <span class="pill ${uu.available ? "ok" : "warn"}">${uu.available ? `UU v${esc(uu.version || "?")}` : "UU 未就绪"}</span>
      <button id="uuRefreshBtn" class="btn subtle" style="padding:2px 6px;font-size:11px">刷新设备</button>
    </div>

    <div class="thread-list">
      <div class="thread-group-label">远端设备 (${devices.length})</div>
      ${
        devices.length === 0
          ? `<div style="padding:8px 6px;font-size:11px;color:var(--cx-muted)">${esc(uu.reason || "暂无在线或已绑定设备")}</div>`
          : devices
              .map((d: UuDeviceInfo) => {
                const active = activeDev?.deviceId === d.deviceId;
                return `
                  <button class="thread-item ${active ? "active" : ""}" data-uu-device="${esc(d.deviceId)}">
                    <div class="thread-top">
                      <div class="thread-name-wrap">
                        <span class="dot ${d.isOnline ? "completed" : "cancelled"}"></span>
                        <span class="thread-title">${esc(d.deviceName)}</span>
                      </div>
                      <span class="engine-badge ${platformTag(d.platform) === "Mac" ? "claude" : "codex"}">${platformTag(d.platform)}</span>
                    </div>
                    <div class="thread-meta">
                      <span>${d.isOnline ? "在线" : "离线"} · ${esc(d.deviceId.slice(0, 8))}</span>
                      <span>${d.allowed ? "白名单" : "需审批"}</span>
                    </div>
                  </button>
                `;
              })
              .join("")
      }

      ${
        activeDev
          ? `<div class="thread-group-label" style="display:flex;justify-content:space-between;align-items:center">
              <span>终端会话 (${sessions.length})</span>
              <button id="uuNewSessionBtn" class="btn subtle" style="padding:0 5px;font-size:10.5px">+ 新建</button>
            </div>
            ${
              sessions.length === 0
                ? `<div style="padding:6px;font-size:11px;color:var(--cx-muted)">暂无远端会话，执行命令时将自动创建 <code>${esc(selectedSession)}</code></div>`
                : sessions
                    .map(
                      (s) => `
                        <button class="thread-item ${selectedSession === s.name ? "active" : ""}" data-uu-session="${esc(s.name)}">
                          <div class="thread-top">
                            <span class="thread-title">$_ ${esc(s.name)}</span>
                            ${s.managed ? `<span class="pill ok" style="font-size:9.5px;padding:0 4px">托管</span>` : ""}
                          </div>
                          ${s.shell ? `<div class="thread-meta"><span>${esc(s.shell)}</span></div>` : ""}
                        </button>
                      `,
                    )
                    .join("")
            }`
          : ""
      }
    </div>

    <div class="sidebar-footer">
      <div class="sidebar-controls">
        <button id="uuToggleEnabledBtn" class="btn ${uu.settings.enabled ? "primary" : ""}" style="flex:1;padding:3px 6px">
          ${uu.settings.enabled ? "远程:开" : "远程:关"}
        </button>
        <button id="uuToggleReadOnlyBtn" class="btn ${uu.settings.readOnly ? "danger" : ""}" style="flex:1;padding:3px 6px">
          ${uu.settings.readOnly ? "只读:开" : "只读:关"}
        </button>
      </div>
      <div class="sidebar-controls">
        <button id="uuToggleSkipConfirmBtn" class="btn ${uu.settings.skipConfirmForAllowlist ? "primary" : ""}" style="width:100%;padding:3px 6px" title="开启后白名单设备将跳过所有写操作与危险命令审批">
          ${uu.settings.skipConfirmForAllowlist ? "白名单免批:开" : "白名单免批:关"}
        </button>
      </div>
      <div class="sidebar-controls">
        <select id="uuConfirmModeSelect" class="select-compact" style="width:100%" title="命令审批策略">
          <option value="allowlist" ${uu.settings.confirmMode === "allowlist" ? "selected" : ""}>策略: 仅白名单设备免批</option>
          <option value="always" ${uu.settings.confirmMode === "always" ? "selected" : ""}>策略: 每次写操作均需批准</option>
          <option value="off" ${uu.settings.confirmMode === "off" ? "selected" : ""}>策略: 关闭普通确认(高危仍拦)</option>
        </select>
      </div>
    </div>
  `;
}

function renderPendingCard(p: UuPendingRequest): string {
  return `
    <div class="uu-pending-card ${p.dangerous ? "dangerous" : ""}">
      <div class="uu-pending-head">
        <span class="pill ${p.dangerous ? "err" : "warn"}">${p.dangerous ? "高危拦截" : "待批准"}</span>
        <strong>${esc(p.deviceName)}</strong>
        <span style="font-size:11px;color:var(--cx-muted)">${esc(p.action)} · 会话 ${esc(p.session)} (${esc(p.shell)})</span>
      </div>
      <div style="font-size:11.5px;color:var(--cx-muted)">${esc(p.reason)}</div>
      ${p.command ? `<pre class="uu-cmd-preview">${esc(p.command)}</pre>` : ""}
      <div class="uu-pending-actions">
        <button class="btn primary" data-uu-act="approve" data-pending-id="${esc(p.id)}">批准执行</button>
        ${
          !p.dangerous
            ? `<button class="btn" data-uu-act="approve-allow" data-pending-id="${esc(p.id)}">批准并加入白名单</button>`
            : ""
        }
        <button class="btn danger" data-uu-act="reject" data-pending-id="${esc(p.id)}">拒绝</button>
      </div>
    </div>
  `;
}

export function renderRemoteStage(
  uu: UuSnapshot | undefined,
  selectedDeviceId: string | null,
  selectedSession: string,
  busy: boolean,
): string {
  if (!uu) {
    return `
      <main class="stage">
        <div class="welcome-stage">
          <div class="welcome-hero">
            <h2>正在连接 UU 远程模块...</h2>
            <p>等待服务端状态初始化。</p>
          </div>
        </div>
      </main>
    `;
  }

  const devices = uu.devices || [];
  const activeDev =
    devices.find((d) => d.deviceId === selectedDeviceId) || devices[0] || null;
  const pending = uu.pending || [];
  const auditItems = activeDev
    ? (uu.audit || []).filter((a) => a.deviceId === activeDev.deviceId)
    : uu.audit || [];
  const shellDefault = activeDev ? defaultShell(activeDev.platform) : "powershell";
  const canExecute =
    uu.available &&
    uu.settings.enabled &&
    !uu.settings.readOnly &&
    Boolean(activeDev?.isOnline) &&
    !busy;

  return `
    <main class="stage">
      <div class="stage-header">
        <div class="stage-title-group">
          ${
            activeDev
              ? `<span class="dot ${activeDev.isOnline ? "completed" : "cancelled"}"></span>
                 <h1 class="stage-title">${esc(activeDev.deviceName)}</h1>
                 <span class="pill">${esc(activeDev.platform)} · ${esc(activeDev.deviceId)}</span>
                 <span class="pill ${activeDev.allowed ? "ok" : "warn"}">${activeDev.allowed ? (uu.settings.skipConfirmForAllowlist ? "白名单免审批" : "白名单已授权") : "未在白名单"}</span>`
              : `<h1 class="stage-title">UU 远程终端</h1>
                 <span class="pill ${uu.available ? "ok" : "warn"}">${uu.available ? "已连接" : "未就绪"}</span>`
          }
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${
            activeDev
              ? `<button id="uuToggleAllowBtn" class="btn ${activeDev.allowed ? "" : "primary"}" data-device-id="${esc(activeDev.deviceId)}">${activeDev.allowed ? "移出白名单" : "加入白名单"}</button>
                 <button id="uuKillSessionBtn" class="btn danger" data-device-id="${esc(activeDev.deviceId)}">关闭会话 ${esc(selectedSession)}</button>`
              : ""
          }
          <button id="uuStageRefreshBtn" class="btn subtle">刷新</button>
        </div>
      </div>

      ${
        !uu.available
          ? `<div class="error-banner" style="margin:12px 14px 0"><strong>UU 远程未就绪：</strong>${esc(uu.reason || "请确认本机已安装并登录网易UU远程客户端")}</div>`
          : !uu.settings.enabled
            ? `<div class="error-banner" style="margin:12px 14px 0;border-color:rgba(240,168,48,0.4);background:rgba(240,168,48,0.08);color:var(--cx-amber)"><strong>远程总开关已关闭：</strong>点击左下角「远程:关」即可启用模型与面板远控终端能力。</div>`
            : ""
      }

      <div class="timeline" id="uuTimelineScroll">
        ${
          pending.length > 0
            ? `<div style="display:flex;flex-direction:column;gap:8px">
                <div class="thread-group-label" style="display:block;padding:0">待你批准的操作 (${pending.length})</div>
                ${pending.map(renderPendingCard).join("")}
              </div>`
            : ""
        }

        <section class="steps-panel">
          <div class="steps-panel-head" style="cursor:default">
            <span>远端执行与审计轨迹 · ${auditItems.length} 条记录</span>
            <span>会话: <code>${esc(selectedSession)}</code></span>
          </div>
          <div class="steps-panel-body" style="max-height:none">
            ${
              auditItems.length === 0
                ? `<div class="step-row"><span class="txt" style="color:var(--cx-muted)">暂无远程命令记录。你可以在下方输入命令直接测试，或让总指挥调用 <code>uu_term</code>。</span></div>`
                : auditItems
                    .slice(0, 30)
                    .map((a) => {
                      const badge = decisionLabel(a.decision);
                      return `
                        <div class="uu-audit-item">
                          <div class="uu-audit-meta">
                            <span class="pill ${badge.cls}" style="font-size:10px;padding:0 5px">${badge.text}</span>
                            <span>${new Date(a.ts).toLocaleTimeString()}</span>
                            <span>[${esc(a.source)}] ${esc(a.action)} · ${esc(a.session || "-")}</span>
                            ${typeof a.exitCode === "number" ? `<span>exit=${a.exitCode}</span>` : ""}
                            ${typeof a.durationMs === "number" ? `<span>${a.durationMs}ms</span>` : ""}
                          </div>
                          ${a.command ? `<div class="uu-audit-cmd">$ ${esc(a.command)}</div>` : ""}
                          ${a.outputPreview ? `<pre class="uu-audit-out">${esc(a.outputPreview)}</pre>` : ""}
                          ${a.reason && a.decision !== "allowed" && a.decision !== "approved" ? `<div style="font-size:11px;color:var(--cx-muted)">${esc(a.reason)}</div>` : ""}
                        </div>
                      `;
                    })
                    .join("")
            }
          </div>
        </section>
      </div>

      <div class="composer-dock">
        <div class="composer-box">
          <textarea id="uuCmdInput" rows="2" ${canExecute ? "" : "disabled"} placeholder="${
            !uu.available
              ? "UU 远程不可用..."
              : !uu.settings.enabled
                ? "请先开启左下角「远程」总开关..."
                : uu.settings.readOnly
                  ? "只读模式已开启，禁止执行写入命令..."
                  : !activeDev?.isOnline
                    ? "当前设备离线..."
                    : "输入要在远端执行的命令（Ctrl+Enter 执行）..."
          }"></textarea>
          <div class="composer-toolbar">
            <div class="composer-pills">
              <select id="uuShellSelect" class="select-compact">
                <option value="powershell" ${shellDefault === "powershell" ? "selected" : ""}>PowerShell</option>
                <option value="cmd" ${shellDefault === "cmd" ? "selected" : ""}>CMD</option>
                <option value="zsh" ${shellDefault === "zsh" ? "selected" : ""}>zsh</option>
                <option value="bash" ${shellDefault === "bash" ? "selected" : ""}>bash</option>
              </select>
              <input id="uuSessionInput" type="text" value="${esc(selectedSession)}" placeholder="会话名" style="width:120px;border:1px solid var(--cx-border);background:var(--cx-surface-2);border-radius:6px;padding:2px 7px" />
            </div>
            <button id="uuRunCmdBtn" class="btn primary" ${canExecute ? "" : "disabled"}>${busy ? "执行中..." : "执行命令"}</button>
          </div>
        </div>
      </div>
    </main>
  `;
}
